import crypto from 'node:crypto';
import { Candidate, Job, Meeting } from '../models';
import { config } from '../config';
import { HttpError } from '../lib/http';
import { changeStatus, logActivity } from './activity';
import { postAssistant } from './chat';

export async function ensureBookingLink(candidate: any) {
  if (config.calendlyUrl) return config.calendlyUrl;
  if (!candidate.bookingToken) {
    candidate.bookingToken = crypto.randomBytes(16).toString('hex');
    await Candidate.updateOne({ _id: candidate._id }, { bookingToken: candidate.bookingToken });
  }
  return `${config.frontendUrl}/book/${candidate.bookingToken}`;
}

export function availableSlots(from = new Date()) {
  const slots: Date[] = [];
  const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (slots.length < 15) {
    day.setUTCDate(day.getUTCDate() + 1);
    if ([0, 6].includes(day.getUTCDay())) continue;
    for (const hour of [9, 13, 15]) {
      slots.push(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour)));
    }
  }
  return slots;
}

async function findByToken(token: string) {
  const candidate = await Candidate.findOne({ bookingToken: token });
  if (!candidate) throw new HttpError(404, 'This booking link is not valid');
  const job = await Job.findById(candidate.jobId);
  return { candidate, job };
}

export async function getBooking(token: string) {
  const { candidate, job } = await findByToken(token);
  const meeting = await Meeting.findOne({ candidateId: candidate._id });
  const taken = new Set((await Meeting.find({ jobId: candidate.jobId })).map((m: any) => m.slot.toISOString()));
  return {
    firstName: candidate.name.split(' ')[0],
    jobTitle: job?.title,
    booked: meeting ? meeting.slot : null,
    slots: availableSlots()
      .filter((s) => !taken.has(s.toISOString()))
      .map((s) => s.toISOString()),
  };
}

export async function bookSlot(token: string, slotIso: string) {
  const { candidate, job } = await findByToken(token);
  if (await Meeting.exists({ candidateId: candidate._id })) throw new HttpError(409, 'You already booked a time, thanks!');
  if (candidate.status !== 'interested') throw new HttpError(409, 'This link is not active right now');

  const slot = availableSlots().find((s) => s.toISOString() === slotIso);
  if (!slot) throw new HttpError(400, 'That time is not available');
  if (await Meeting.exists({ jobId: candidate.jobId, slot })) throw new HttpError(409, 'Someone just took that time, please pick another');

  try {
    await Meeting.create({ jobId: candidate.jobId, candidateId: candidate._id, slot });
  } catch (err: any) {
    if (err?.code === 11000) throw new HttpError(409, 'Someone just took that time, please pick another');
    throw err;
  }
  await changeStatus(candidate._id, 'meeting_booked', { actor: 'candidate', note: `slot ${slot.toISOString()}` });
  await logActivity({
    jobId: candidate.jobId,
    candidateId: candidate._id,
    actor: 'candidate',
    type: 'meeting_booked',
    message: `${candidate.name} booked a meeting for ${slot.toUTCString()}`,
  });

  if (job?.conversationId) {
    await postAssistant(
      job.conversationId,
      `**${candidate.name}** picked a time: ${slot.toUTCString()}. I moved them to *Meeting booked*.`,
      [{ type: 'suggestions', ref: { items: [`How is the ${job.title} job going?`] } }],
    );
  }
  return { slot };
}
