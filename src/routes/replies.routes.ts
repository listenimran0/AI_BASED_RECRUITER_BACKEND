import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/http';
import { approveReplyDraft, discardReplyDraft, submitReply } from '../services/replies';

export const repliesRouter = Router();

export async function simulateReply(req: any, res: any) {
  const body = parse(z.object({ candidateId: z.string(), text: z.string().trim().min(1).max(5000) }), req.body);
  res.status(202).json(await submitReply(body.candidateId, body.text));
}
repliesRouter.post('/simulate-reply', simulateReply);

repliesRouter.post('/replies/:draftId/approve', async (req, res) => {
  const edits = parse(z.object({ subject: z.string().optional(), body: z.string().optional() }), req.body ?? {});
  await approveReplyDraft(req.params.draftId, edits, 'recruiter:ui');
  res.json({ ok: true });
});

repliesRouter.post('/replies/:draftId/discard', async (req, res) => {
  await discardReplyDraft(req.params.draftId, 'recruiter:ui');
  res.json({ ok: true });
});
