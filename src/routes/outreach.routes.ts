import { Router } from 'express';
import { z } from 'zod';
import { refresh } from '../lib/events';
import { HttpError, parse } from '../lib/http';
import { OutreachMessage } from '../models';

export const outreachRouter = Router();

outreachRouter.patch('/outreach/:id', async (req, res) => {
  const body = parse(z.object({ subject: z.string().trim().max(150).optional(), body: z.string().trim().max(4000).optional() }), req.body);
  const draft = await OutreachMessage.findOneAndUpdate({ _id: req.params.id, status: 'draft' }, body, { returnDocument: 'after' });
  if (!draft) throw new HttpError(409, 'Only drafts can be edited');
  refresh('campaign', { jobId: draft.jobId, id: draft.campaignId });
  res.json(draft);
});

outreachRouter.post('/outreach/:id/skip', async (req, res) => {
  const draft = await OutreachMessage.findOneAndUpdate({ _id: req.params.id, kind: 'outreach', status: 'draft' }, { status: 'cancelled', note: 'removed by recruiter' }, { returnDocument: 'after' });
  if (!draft) throw new HttpError(409, 'Only drafts can be removed');
  refresh('campaign', { jobId: draft.jobId, id: draft.campaignId });
  res.json(draft);
});
