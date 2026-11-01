import { Candidate, Job, SourcingRun } from '../models';
import { HttpError } from '../lib/http';
import { refresh } from '../lib/events';
import { cleanUntrusted } from '../lib/sanitize';
import { normalizeProfileUrl, usingMockSearch } from '../lib/search';
import { parseCandidateCsv } from '../lib/csv';
import { sourcingQueue, scoringQueue } from '../queues';
import { logActivity } from './activity';
import { postAssistant } from './chat';

export type NewCandidate = {
  name: string;
  email?: string;
  profileUrl?: string;
  headline?: string;
  company?: string;
  location?: string;
  skills?: string[];
  snippet?: string;
  notes?: string;
};

type Source = 'serper' | 'csv' | 'mock-search';

export async function addCandidates(jobId: unknown, runId: unknown, items: NewCandidate[], source: Source) {
  const created: any[] = [];
  let duplicates = 0;

  for (const item of items) {
    const email = item.email?.trim().toLowerCase() || undefined;
    const urlKey = item.profileUrl ? normalizeProfileUrl(item.profileUrl) || undefined : undefined;
    if (!email && !urlKey) continue;

    const lookups: object[] = [];
    if (email) lookups.push({ email });
    if (urlKey) lookups.push({ urlKey });
    if (await Candidate.exists({ jobId, $or: lookups })) {
      duplicates++;
      continue;
    }

    const name = cleanUntrusted(item.name.replace(/\s+/g, ' '), 80);
    const headline = cleanUntrusted(item.headline, 200);
    const company = cleanUntrusted(item.company, 120);
    const location = cleanUntrusted(item.location, 120);
    const snippet = cleanUntrusted(item.snippet, 700);
    const notes = cleanUntrusted(item.notes, 900);
    const skills = (item.skills || []).slice(0, 30).map((s) => cleanUntrusted(s, 40));
    const injectionFlag = [name, headline, company, location, snippet, notes, ...skills].some((c) => c.flagged);

    try {
      created.push(
        await Candidate.create({
          jobId,
          runId,
          name: name.text,
          email,
          profileUrl: item.profileUrl,
          urlKey,
          headline: headline.text,
          company: company.text,
          location: location.text,
          skills: skills.map((s) => s.text).filter(Boolean),
          snippet: snippet.text,
          notes: notes.text,
          source,
          dedupeKey: email ? `email:${email}` : `url:${urlKey}`,
          injectionFlag,
        }),
      );
    } catch (err: any) {
      if (err?.code === 11000) duplicates++;
      else throw err;
    }
  }
  return { created, duplicates };
}

export async function enqueueScoring(candidates: any[], runId: unknown) {
  for (const c of candidates) {
    await scoringQueue.add('score', { candidateId: String(c._id), runId: String(runId) }, { jobId: `score-${c._id}` });
  }
}

export async function startWebSourcing(jobId: string, conversationId: unknown, target = 30) {
  const job = await Job.findById(jobId);
  if (!job) throw new HttpError(404, 'Job not found');
  const active = await SourcingRun.findOne({ jobId, status: { $in: ['queued', 'searching', 'scoring'] } });
  if (active) throw new HttpError(409, 'Sourcing is already running for this job');

  const run = await SourcingRun.create({
    jobId,
    conversationId,
    kind: 'web',
    target: Math.min(Math.max(target, 5), 100),
    note: usingMockSearch ? 'SERPER_API_KEY is not set, so sample results are used' : undefined,
  });
  await sourcingQueue.add('source', { runId: String(run._id) }, { jobId: `source-${run._id}` });
  await logActivity({
    jobId,
    actor: 'recruiter:chat',
    type: 'sourcing_started',
    message: `Sourcing started (target ${run.target})`,
  });
  refresh('run', { jobId, id: run._id });
  return run;
}

export async function importCsv(jobId: string, content: string, conversationId?: unknown) {
  const job = await Job.findById(jobId);
  if (!job) throw new HttpError(404, 'Job not found');

  let parsed;
  try {
    parsed = parseCandidateCsv(content);
  } catch (err) {
    throw new HttpError(400, `Could not read the CSV: ${err instanceof Error ? err.message : 'bad format'}`);
  }
  if (!parsed.rows.length) {
    throw new HttpError(400, 'No usable rows found. The file needs a header row with at least name and email columns.');
  }

  const run = await SourcingRun.create({
    jobId,
    conversationId: conversationId || job.conversationId,
    kind: 'csv',
    status: 'scoring',
    target: parsed.rows.length,
    enqueueDone: true,
  });
  const { created, duplicates } = await addCandidates(jobId, run._id, parsed.rows, 'csv');
  await SourcingRun.updateOne(
    { _id: run._id },
    {
      found: created.length,
      duplicates,
      note: parsed.skipped.length ? `${parsed.skipped.length} rows skipped (e.g. line ${parsed.skipped[0].line}: ${parsed.skipped[0].reason})` : undefined,
    },
  );
  await logActivity({
    jobId,
    actor: 'recruiter:ui',
    type: 'csv_uploaded',
    message: `CSV uploaded: ${created.length} added, ${duplicates} duplicates, ${parsed.skipped.length} skipped`,
  });

  await enqueueScoring(created, run._id);
  refresh('candidate', { jobId });

  if (conversationId) {
    const bits = [`Imported **${created.length}** candidate${created.length === 1 ? '' : 's'} for **${job.title}**`];
    if (duplicates) bits.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'} skipped`);
    if (parsed.skipped.length) bits.push(`${parsed.skipped.length} row${parsed.skipped.length === 1 ? '' : 's'} could not be used`);
    await postAssistant(conversationId, `${bits.join(', ')}. I am scoring them against the job now.`, [{ type: 'run', ref: { runId: String(run._id) } }]);
  }
  await finishRunIfDone(run._id);
  return { run: await SourcingRun.findById(run._id), added: created.length, duplicates, skipped: parsed.skipped };
}

export async function syncRunCounts(runId: unknown) {
  const [found, scored, failed] = await Promise.all([
    Candidate.countDocuments({ runId }),
    Candidate.countDocuments({ runId, score: { $ne: null } }),
    Candidate.countDocuments({ runId, score: null, scoreError: { $ne: null } }),
  ]);
  return SourcingRun.findByIdAndUpdate(runId, { found, scored, failed }, { returnDocument: 'after' });
}

export async function finishRunIfDone(runId: unknown) {
  const run = await syncRunCounts(runId);
  if (!run || !run.enqueueDone || run.status === 'done' || run.status === 'failed') return;
  if (run.scored + run.failed < run.found) return;

  // only one worker gets to flip the status and post the summary
  const won = await SourcingRun.findOneAndUpdate({ _id: runId, status: { $in: ['searching', 'scoring', 'queued'] } }, { status: 'done' }, { returnDocument: 'after' });
  if (!won) return;
  refresh('run', { jobId: won.jobId, id: won._id });

  const job = await Job.findById(won.jobId);
  const top = await Candidate.find({ jobId: won.jobId, runId: won._id, score: { $ne: null } }).sort({ score: -1 }).limit(3);
  const lines = [
    `Sourcing finished for **${job?.title}**: ${won.found} new candidates` +
      (won.duplicates ? ` (${won.duplicates} duplicates skipped)` : '') +
      `, ${won.scored} scored` +
      (won.failed ? `, ${won.failed} could not be scored` : '') +
      '.',
  ];
  if (top.length) lines.push(`Best matches so far: ${top.map((c: any) => `${c.name} (${c.score})`).join(', ')}.`);
  if (!won.found) lines.push('Nothing new turned up. You can upload a CSV or tweak the job requirements.');

  if (won.conversationId) {
    await postAssistant(
      won.conversationId,
      lines.join('\n\n'),
      won.found
        ? [
            { type: 'candidates', ref: { jobId: String(won.jobId), mode: 'review' } },
            { type: 'suggestions', ref: { items: ['Accept the top 5', 'Show the candidates again'] } },
          ]
        : [],
    );
  }
}
