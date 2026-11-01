import { Router } from 'express';
import { z } from 'zod';
import { refresh } from '../lib/events';
import { must, parse } from '../lib/http';
import { transitions } from '../lib/status';
import { ActivityLog, Campaign, Candidate, Job, OutreachMessage, Reply, STATUSES, type Status } from '../models';
import { jobStats, listJobsWithStats, summarizeJob } from '../services/stats';

export const jobsRouter = Router();

jobsRouter.get('/jobs', async (_req, res) => {
  res.json(await listJobsWithStats());
});

jobsRouter.get('/jobs/:id', async (req, res) => {
  res.json(await must(Job.findById(req.params.id), 'Job'));
});

jobsRouter.patch('/jobs/:id', async (req, res) => {
  const body = parse(z.object({ autoReply: z.boolean() }), req.body);
  const job = await must(Job.findByIdAndUpdate(req.params.id, body, { returnDocument: 'after' }), 'Job');
  refresh('job', { jobId: job._id });
  res.json(job);
});

jobsRouter.get('/jobs/:id/stats', async (req, res) => {
  await must(Job.findById(req.params.id), 'Job');
  res.json(await jobStats(req.params.id));
});

jobsRouter.get('/jobs/:id/summary', async (req, res) => {
  await must(Job.findById(req.params.id), 'Job');
  res.json({ summary: await summarizeJob(req.params.id) });
});

jobsRouter.get('/jobs/:id/candidates', async (req, res) => {
  const query: Record<string, unknown> = { jobId: req.params.id };
  const status = String(req.query.status || '');
  if ((STATUSES as readonly string[]).includes(status)) query.status = status;
  const candidates = await Candidate.find(query).sort({ score: -1, createdAt: 1 }).limit(500);
  res.json(candidates.map((c: any) => ({ ...c.toJSON(), next: transitions[c.status as Status] })));
});

jobsRouter.get('/jobs/:id/activity', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await ActivityLog.find({ jobId: req.params.id }).sort({ createdAt: -1 }).limit(limit));
});

jobsRouter.get('/jobs/:id/campaigns', async (req, res) => {
  res.json(await Campaign.find({ jobId: req.params.id }).sort({ createdAt: -1 }));
});

jobsRouter.get('/jobs/:id/replies', async (req, res) => {
  const replies = await Reply.find({ jobId: req.params.id }).sort({ createdAt: -1 }).limit(100);
  const candidates = await Candidate.find({ _id: { $in: replies.map((r: any) => r.candidateId) } });
  const drafts = await OutreachMessage.find({ _id: { $in: replies.map((r: any) => r.draftId).filter(Boolean) } });
  const candidateById = new Map(candidates.map((c: any) => [String(c._id), c]));
  const draftById = new Map(drafts.map((d: any) => [String(d._id), d]));

  res.json(
    replies.map((r: any) => ({
      ...r.toJSON(),
      candidate: candidateById.get(String(r.candidateId)),
      draft: r.draftId ? draftById.get(String(r.draftId)) || null : null,
    })),
  );
});
