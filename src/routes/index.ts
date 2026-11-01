import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  ActivityLog,
  Campaign,
  Candidate,
  Conversation,
  Job,
  Message,
  OutreachMessage,
  Reply,
  SourcingRun,
  STATUSES,
  type Status,
} from '../models';
import { actionPreview, cancelAction, confirmAction } from '../actions';
import { runAgentTurn } from '../agent';
import { HttpError, parse } from '../lib/http';
import { EVENTS_CHANNEL, refresh } from '../lib/events';
import { newRedis, redis } from '../redis';
import { transitions } from '../lib/status';
import { isEmail } from '../lib/csv';
import { changeStatus, logActivity } from '../services/activity';
import { bookSlot, getBooking } from '../services/booking';
import { approveCampaign, setCampaignPaused } from '../services/campaigns';
import { createConversation, postUser } from '../services/chat';
import { approveReplyDraft, discardReplyDraft, submitReply } from '../services/replies';
import { importCsv } from '../services/sourcing';
import { jobStats, listJobsWithStats, summarizeJob } from '../services/stats';

export const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const SAMPLE_PROMPT = 'Use the sample job description';

function sampleJobDescription() {
  const file = path.resolve(__dirname, '../../seed/sample-jd.txt');
  return fs.readFileSync(file, 'utf8');
}

async function must(query: PromiseLike<any>, what: string): Promise<any> {
  const doc = await Promise.resolve(query).catch(() => null);
  if (!doc) throw new HttpError(404, `${what} not found`);
  return doc;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);
const subscriber = newRedis();
subscriber.subscribe(EVENTS_CHANNEL);
subscriber.on('message', (_channel, raw) => bus.emit('event', raw));

router.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const send = (raw: string) => res.write(`data: ${raw}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('event', send);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});

router.post('/conversations', async (_req, res) => {
  res.status(201).json(await createConversation());
});

router.get('/conversations', async (_req, res) => {
  res.json(await Conversation.find().sort({ updatedAt: -1 }).limit(20));
});

router.get('/conversations/:id', async (req, res) => {
  res.json(await must(Conversation.findById(req.params.id), 'Conversation'));
});

router.get('/conversations/:id/messages', async (req, res) => {
  await must(Conversation.findById(req.params.id), 'Conversation');
  res.json(await Message.find({ conversationId: req.params.id }).sort({ createdAt: 1 }).limit(500));
});

router.post('/conversations/:id/messages', async (req, res) => {
  const { text } = parse(z.object({ text: z.string().trim().min(1).max(20000) }), req.body);
  const conversation = await must(Conversation.findById(req.params.id), 'Conversation');
  const conversationId = String(conversation._id);

  const lock = await redis.set(`lock:chat:${conversationId}`, '1', 'EX', 120, 'NX');
  if (!lock) throw new HttpError(409, 'I am still working on your previous message');

  const content = text === SAMPLE_PROMPT ? `Here is the job description:\n\n${sampleJobDescription()}` : text;
  const message = await postUser(conversationId, content);
  if (conversation.title === 'New chat') await Conversation.updateOne({ _id: conversationId }, { title: text.slice(0, 60) });

  res.status(202).json(message);

  runAgentTurn(conversationId).finally(() => redis.del(`lock:chat:${conversationId}`));
});

router.get('/actions/:id', async (req, res) => {
  res.json(await actionPreview(req.params.id));
});

router.post('/actions/:id/confirm', async (req, res) => {
  const edits = parse(z.object({ payload: z.record(z.string(), z.unknown()).optional() }), req.body ?? {});
  res.json(await confirmAction(req.params.id, edits.payload));
});

router.post('/actions/:id/cancel', async (req, res) => {
  res.json(await cancelAction(req.params.id));
});

router.get('/jobs', async (_req, res) => {
  res.json(await listJobsWithStats());
});

router.get('/jobs/:id', async (req, res) => {
  res.json(await must(Job.findById(req.params.id), 'Job'));
});

router.patch('/jobs/:id', async (req, res) => {
  const body = parse(z.object({ autoReply: z.boolean() }), req.body);
  const job = await must(Job.findByIdAndUpdate(req.params.id, body, { returnDocument: 'after' }), 'Job');
  refresh('job', { jobId: job._id });
  res.json(job);
});

router.get('/jobs/:id/stats', async (req, res) => {
  await must(Job.findById(req.params.id), 'Job');
  res.json(await jobStats(req.params.id));
});

router.get('/jobs/:id/summary', async (req, res) => {
  await must(Job.findById(req.params.id), 'Job');
  res.json({ summary: await summarizeJob(req.params.id) });
});

router.get('/jobs/:id/candidates', async (req, res) => {
  const query: Record<string, unknown> = { jobId: req.params.id };
  const status = String(req.query.status || '');
  if ((STATUSES as readonly string[]).includes(status)) query.status = status;
  const candidates = await Candidate.find(query).sort({ score: -1, createdAt: 1 }).limit(500);
  res.json(candidates.map((c: any) => ({ ...c.toJSON(), next: transitions[c.status as Status] })));
});

router.get('/jobs/:id/activity', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(await ActivityLog.find({ jobId: req.params.id }).sort({ createdAt: -1 }).limit(limit));
});

router.get('/jobs/:id/campaigns', async (req, res) => {
  res.json(await Campaign.find({ jobId: req.params.id }).sort({ createdAt: -1 }));
});

router.get('/jobs/:id/replies', async (req, res) => {
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

router.post('/jobs/:id/candidates/csv', upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach a CSV file in the "file" field');
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined;
  if (conversationId) await postUser(conversationId, `Uploaded ${req.file.originalname}`);
  const result = await importCsv(String(req.params.id), req.file.buffer.toString('utf8'), conversationId);
  res.status(201).json(result);
});

router.get('/runs/:id', async (req, res) => {
  res.json(await must(SourcingRun.findById(req.params.id), 'Run'));
});

router.patch('/candidates/:id/status', async (req, res) => {
  const body = parse(z.object({ status: z.enum(STATUSES), note: z.string().max(200).optional() }), req.body);
  const { candidate } = await changeStatus(req.params.id, body.status, { actor: 'recruiter:ui', note: body.note });
  res.json(candidate);
});

// web sourcing only finds profile links, so the recruiter fills in the address by hand
router.patch('/candidates/:id/email', async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().max(254) }), req.body);
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');

  const candidate = await must(Candidate.findById(req.params.id), 'Candidate');
  const taken = await Candidate.exists({ jobId: candidate.jobId, email, _id: { $ne: candidate._id } });
  if (taken) throw new HttpError(409, 'Another candidate for this job already has that email');

  candidate.email = email;
  await candidate.save();
  await logActivity({
    jobId: candidate.jobId,
    candidateId: candidate._id,
    actor: 'recruiter:ui',
    type: 'email_added',
    message: `Email added for ${candidate.name}`,
  });
  refresh('candidate', { jobId: candidate.jobId, id: candidate._id });
  res.json(candidate);
});

router.get('/campaigns/:id', async (req, res) => {
  const campaign = await must(Campaign.findById(req.params.id), 'Campaign');
  const messages = await OutreachMessage.find({ campaignId: campaign._id, kind: 'outreach' }).sort({ stepIndex: 1 });
  const candidates = await Candidate.find({ _id: { $in: campaign.candidateIds } }).sort({ score: -1 });
  const items = candidates
    .map((c: any) => ({
      candidate: { id: String(c._id), name: c.name, email: c.email, score: c.score, status: c.status },
      messages: messages.filter((m: any) => String(m.candidateId) === String(c._id)),
    }))
    .filter((item: any) => item.messages.length || campaign.status === 'drafting');

  const sent = messages.filter((m: any) => m.status === 'sent').length;
  res.json({ campaign, items, progress: { total: campaign.candidateIds.length, drafted: items.filter((i: any) => i.messages.length).length, failed: campaign.draftsFailed, sent } });
});

router.post('/campaigns/:id/approve', async (req, res) => {
  res.json(await approveCampaign(req.params.id, 'recruiter:ui'));
});

router.post('/campaigns/:id/pause', async (req, res) => {
  res.json(await setCampaignPaused(req.params.id, true, 'recruiter:ui'));
});

router.post('/campaigns/:id/resume', async (req, res) => {
  res.json(await setCampaignPaused(req.params.id, false, 'recruiter:ui'));
});

router.patch('/outreach/:id', async (req, res) => {
  const body = parse(z.object({ subject: z.string().trim().max(150).optional(), body: z.string().trim().max(4000).optional() }), req.body);
  const draft = await OutreachMessage.findOneAndUpdate({ _id: req.params.id, status: 'draft' }, body, { returnDocument: 'after' });
  if (!draft) throw new HttpError(409, 'Only drafts can be edited');
  refresh('campaign', { jobId: draft.jobId, id: draft.campaignId });
  res.json(draft);
});

router.post('/outreach/:id/skip', async (req, res) => {
  const draft = await OutreachMessage.findOneAndUpdate({ _id: req.params.id, kind: 'outreach', status: 'draft' }, { status: 'cancelled', note: 'removed by recruiter' }, { returnDocument: 'after' });
  if (!draft) throw new HttpError(409, 'Only drafts can be removed');
  refresh('campaign', { jobId: draft.jobId, id: draft.campaignId });
  res.json(draft);
});

export async function simulateReply(req: any, res: any) {
  const body = parse(z.object({ candidateId: z.string(), text: z.string().trim().min(1).max(5000) }), req.body);
  res.status(202).json(await submitReply(body.candidateId, body.text));
}
router.post('/simulate-reply', simulateReply);

router.post('/replies/:draftId/approve', async (req, res) => {
  const edits = parse(z.object({ subject: z.string().optional(), body: z.string().optional() }), req.body ?? {});
  await approveReplyDraft(req.params.draftId, edits, 'recruiter:ui');
  res.json({ ok: true });
});

router.post('/replies/:draftId/discard', async (req, res) => {
  await discardReplyDraft(req.params.draftId, 'recruiter:ui');
  res.json({ ok: true });
});

router.get('/public/booking/:token', async (req, res) => {
  res.json(await getBooking(req.params.token));
});

router.post('/public/booking/:token', async (req, res) => {
  const { slot } = parse(z.object({ slot: z.string() }), req.body);
  res.status(201).json(await bookSlot(req.params.token, slot));
});
