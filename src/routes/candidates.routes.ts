import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { isEmail } from '../lib/csv';
import { refresh } from '../lib/events';
import { HttpError, must, parse } from '../lib/http';
import { Candidate, SourcingRun, STATUSES } from '../models';
import { changeStatus, logActivity } from '../services/activity';
import { postUser } from '../services/chat';
import { importCsv } from '../services/sourcing';

export const candidatesRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

candidatesRouter.post('/jobs/:id/candidates/csv', upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach a CSV file in the "file" field');
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : undefined;
  if (conversationId) await postUser(conversationId, `Uploaded ${req.file.originalname}`);
  const result = await importCsv(String(req.params.id), req.file.buffer.toString('utf8'), conversationId);
  res.status(201).json(result);
});

candidatesRouter.get('/runs/:id', async (req, res) => {
  res.json(await must(SourcingRun.findById(req.params.id), 'Run'));
});

candidatesRouter.patch('/candidates/:id/status', async (req, res) => {
  const body = parse(z.object({ status: z.enum(STATUSES), note: z.string().max(200).optional() }), req.body);
  const { candidate } = await changeStatus(req.params.id, body.status, { actor: 'recruiter:ui', note: body.note });
  res.json(candidate);
});

// web sourcing only finds profile links, so the recruiter fills in the address by hand
candidatesRouter.patch('/candidates/:id/email', async (req, res) => {
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
