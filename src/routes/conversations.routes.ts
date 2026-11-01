import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { runAgentTurn } from '../agent';
import { HttpError, must, parse } from '../lib/http';
import { Conversation, Message } from '../models';
import { redis } from '../redis';
import { createConversation, postUser } from '../services/chat';

export const conversationsRouter = Router();

const SAMPLE_PROMPT = 'Use the sample job description';

function sampleJobDescription() {
  const file = path.resolve(__dirname, '../../seed/sample-jd.txt');
  return fs.readFileSync(file, 'utf8');
}

conversationsRouter.post('/conversations', async (_req, res) => {
  res.status(201).json(await createConversation());
});

conversationsRouter.get('/conversations', async (_req, res) => {
  res.json(await Conversation.find().sort({ updatedAt: -1 }).limit(20));
});

conversationsRouter.get('/conversations/:id', async (req, res) => {
  res.json(await must(Conversation.findById(req.params.id), 'Conversation'));
});

conversationsRouter.get('/conversations/:id/messages', async (req, res) => {
  await must(Conversation.findById(req.params.id), 'Conversation');
  res.json(await Message.find({ conversationId: req.params.id }).sort({ createdAt: 1 }).limit(500));
});

conversationsRouter.post('/conversations/:id/messages', async (req, res) => {
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
