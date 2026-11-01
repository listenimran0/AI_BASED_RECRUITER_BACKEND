import { Candidate, OutreachMessage, Reply } from '../models';
import { HttpError } from '../lib/http';
import { cleanUntrusted } from '../lib/sanitize';
import { refresh } from '../lib/events';
import { replyQueue, sendingQueue } from '../queues';
import { changeStatus, logActivity, type Actor } from './activity';
import { enqueueDueMessages } from './campaigns';

const NEVER_CONTACTED = ['sourced', 'accepted', 'rejected'];

export async function submitReply(candidateId: string, text: string) {
  const candidate = await Candidate.findById(candidateId);
  if (!candidate) throw new HttpError(404, 'Candidate not found');
  if (NEVER_CONTACTED.includes(candidate.status)) {
    throw new HttpError(409, `${candidate.name} has not been contacted yet, so there is nothing to reply to`);
  }

  const cleaned = cleanUntrusted(text, 3000);
  if (!cleaned.text) throw new HttpError(400, 'Reply text is empty');

  const reply = await Reply.create({
    jobId: candidate.jobId,
    candidateId: candidate._id,
    text: cleaned.text,
    injectionFlag: cleaned.flagged,
  });

  // follow-ups stop immediately, classification can take a few seconds
  if (candidate.status === 'contacted') await changeStatus(candidate._id, 'replied', { actor: 'candidate' });

  await logActivity({
    jobId: candidate.jobId,
    candidateId: candidate._id,
    actor: 'candidate',
    type: 'reply_received',
    message: `${candidate.name} replied${cleaned.flagged ? ' (flagged: contains instruction-like text)' : ''}`,
  });
  await replyQueue.add('classify', { replyId: String(reply._id) }, { jobId: `reply-${reply._id}` });
  refresh('reply', { jobId: candidate.jobId, id: reply._id });
  return reply;
}

export async function approveReplyDraft(draftId: string, edits: { subject?: string; body?: string }, actor: Actor) {
  const draft = await OutreachMessage.findOne({ _id: draftId, kind: 'reply' });
  if (!draft) throw new HttpError(404, 'Draft not found');
  if (draft.status !== 'draft') throw new HttpError(409, 'This draft was already handled');

  const subject = (edits.subject ?? draft.subject).trim();
  const body = (edits.body ?? draft.body).trim();
  if (!subject || !body) throw new HttpError(400, 'Subject and body cannot be empty');

  const candidate = await Candidate.findById(draft.candidateId);
  if (!candidate || candidate.status === 'unsubscribed') throw new HttpError(409, 'This candidate has unsubscribed, nothing was sent');

  // claim the draft atomically: a double click must not approve (or log) it twice
  const claimed = await OutreachMessage.findOneAndUpdate({ _id: draft._id, status: 'draft' }, { subject, body, status: 'scheduled', scheduledFor: new Date() });
  if (!claimed) throw new HttpError(409, 'This draft was already handled');
  await logActivity({
    jobId: draft.jobId,
    candidateId: draft.candidateId,
    actor,
    type: 'reply_approved',
    message: `Reply to ${candidate.name} approved`,
  });
  await sendingQueue.add('send', { messageId: String(draft._id) }, { jobId: `send-${draft._id}` });
  refresh('reply', { jobId: draft.jobId });
}

export async function discardReplyDraft(draftId: string, actor: Actor) {
  const draft = await OutreachMessage.findOneAndUpdate({ _id: draftId, kind: 'reply', status: 'draft' }, { status: 'cancelled', note: 'discarded by recruiter' });
  if (!draft) throw new HttpError(409, 'This draft was already handled');
  await logActivity({ jobId: draft.jobId, candidateId: draft.candidateId, actor, type: 'reply_discarded', message: 'Reply draft discarded' });
  refresh('reply', { jobId: draft.jobId });
}

export { enqueueDueMessages };
