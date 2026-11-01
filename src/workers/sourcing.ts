import type { Job as QueueJob } from 'bullmq';
import { Job, SourcingRun } from '../models';
import { buildQueries, parseLinkedInHit, searchWeb, usingMockSearch } from '../lib/search';
import { refresh } from '../lib/events';
import { log } from '../logger';
import { isLastAttempt } from '../queues';
import { addCandidates, enqueueScoring, finishRunIfDone, syncRunCounts } from '../services/sourcing';

const MAX_PAGES_PER_QUERY = 3;

export async function processSourcing(queueJob: QueueJob<{ runId: string }>) {
  const run = await SourcingRun.findById(queueJob.data.runId);
  if (!run) return;
  const job = await Job.findById(run.jobId);
  if (!job) return;

  // the sample fixture ignores the query, so one pass is enough
  const queries = usingMockSearch ? buildQueries(job).slice(0, 1) : buildQueries(job);
  await SourcingRun.updateOne({ _id: run._id }, { status: 'searching', queries, error: undefined });
  refresh('run', { jobId: run.jobId, id: run._id });

  try {
    let found = run.found;
    outer: for (const query of queries) {
      for (let page = 1; page <= MAX_PAGES_PER_QUERY; page++) {
        const hits = await searchWeb(query, page);
        if (!hits.length) break;

        // never take more than the recruiter asked for; a page can return 10 hits
        const profiles = hits
          .map(parseLinkedInHit)
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .slice(0, run.target - found);
        const { created, duplicates } = await addCandidates(run.jobId, run._id, profiles, usingMockSearch ? 'mock-search' : 'serper');
        found += created.length;

        await SourcingRun.updateOne({ _id: run._id }, { $inc: { duplicates } });
        await syncRunCounts(run._id);
        await enqueueScoring(created, run._id);
        refresh('run', { jobId: run.jobId, id: run._id });
        refresh('candidate', { jobId: run.jobId });

        if (found >= run.target) break outer;
      }
    }

    await SourcingRun.updateOne({ _id: run._id }, { enqueueDone: true, status: 'scoring' });
    await finishRunIfDone(run._id);
  } catch (err) {
    log.error({ err, runId: String(run._id) }, 'sourcing attempt failed');
    if (isLastAttempt(queueJob)) {
      await SourcingRun.updateOne(
        { _id: run._id },
        { status: 'failed', error: err instanceof Error ? err.message : 'Search failed' },
      );
      refresh('run', { jobId: run.jobId, id: run._id });
      return;
    }
    throw err;
  }
}
