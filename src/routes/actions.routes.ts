import { Router } from 'express';
import { z } from 'zod';
import { actionPreview, cancelAction, confirmAction } from '../actions';
import { parse } from '../lib/http';

export const actionsRouter = Router();

actionsRouter.get('/actions/:id', async (req, res) => {
  res.json(await actionPreview(req.params.id));
});

actionsRouter.post('/actions/:id/confirm', async (req, res) => {
  const edits = parse(z.object({ payload: z.record(z.string(), z.unknown()).optional() }), req.body ?? {});
  res.json(await confirmAction(req.params.id, edits.payload));
});

actionsRouter.post('/actions/:id/cancel', async (req, res) => {
  res.json(await cancelAction(req.params.id));
});
