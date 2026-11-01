import { ActivityLog, Candidate, OutreachMessage, type Status } from '../models';
import { HttpError } from '../lib/http';
import { refresh } from '../lib/events';
import { STATUS_LABEL, STOPS_OUTREACH, canMove } from '../lib/status';

export type Actor = 'recruiter:ui' | 'recruiter:chat' | 'candidate' | 'system' | 'ai';

export async function logActivity(entry: {
  jobId: unknown;
  candidateId?: unknown;
  actor: Actor;
  type: string;
  message: string;
  from?: string;
  to?: string;
  meta?: unknown;
}) {
  await ActivityLog.create(entry);
  refresh('activity', { jobId: entry.jobId });
}

export async function changeStatus(
  candidateId: unknown,
  to: Status,
  opts: { actor: Actor; note?: string; meta?: unknown },
) {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) throw new HttpError(404, 'Candidate not found');
  const from = candidate.status as Status;
  if (from === to) return { candidate, changed: false };

  if (!canMove(from, to)) {
    throw new HttpError(409, `${candidate.name} is ${STATUS_LABEL[from]}; cannot move to ${STATUS_LABEL[to]}`);
  }

  const updated = await Candidate.findOneAndUpdate({ _id: candidate._id, status: from }, { status: to }, { returnDocument: 'after' });
  if (!updated) throw new HttpError(409, `${candidate.name} was changed by someone else, try again`);

  await logActivity({
    jobId: candidate.jobId,
    candidateId: candidate._id,
    actor: opts.actor,
    type: 'status_changed',
    from,
    to,
    message: `${candidate.name}: ${STATUS_LABEL[from]} → ${STATUS_LABEL[to]}${opts.note ? ` (${opts.note})` : ''}`,
    meta: opts.meta,
  });

  if (STOPS_OUTREACH.includes(to)) await cancelFollowUps(candidate._id, `status is now ${to}`);
  refresh('candidate', { jobId: candidate.jobId, id: candidate._id });
  return { candidate: updated, changed: true };
}

export async function cancelFollowUps(candidateId: unknown, reason: string) {
  await OutreachMessage.updateMany(
    { candidateId, kind: 'outreach', status: { $in: ['draft', 'scheduled'] } },
    { status: 'cancelled', note: reason },
  );
}
