import type { Job as QueueJob } from 'bullmq';
import { Campaign, Candidate, OutreachMessage } from '../models';
import { sendMail } from '../lib/mailer';
import { refresh } from '../lib/events';
import { log } from '../logger';
import { isLastAttempt } from '../queues';
import { changeStatus, logActivity } from '../services/activity';
import { completeCampaignIfFinished } from '../services/campaigns';

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const startOfTomorrow = () => new Date(startOfToday().getTime() + 24 * 60 * 60 * 1000);

async function isUnsubscribed(candidate: any) {
  if (candidate.status === 'unsubscribed') return true;
  // an unsubscribe applies to the address, whichever job it came from
  return Boolean(await Candidate.exists({ email: candidate.email, status: 'unsubscribed' }));
}

export async function processSend(queueJob: QueueJob<{ messageId: string }>) {
  // claiming the message is what guarantees nobody gets the same step twice
  const msg = await OutreachMessage.findOneAndUpdate(
    { _id: queueJob.data.messageId, status: 'scheduled' },
    { status: 'sending', $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  );
  if (!msg) return;

  const update = (patch: Record<string, unknown>) => OutreachMessage.updateOne({ _id: msg._id }, patch);
  const skip = (note: string) => update({ status: 'skipped', note });

  try {
    const candidate = await Candidate.findById(msg.candidateId);
    if (!candidate || !candidate.email) {
      await skip('candidate has no email');
    } else if (await isUnsubscribed(candidate)) {
      await skip('candidate unsubscribed');
    } else {
      const proceed = await passesOutreachRules(msg, candidate, update, skip);
      if (proceed) {
        const info = await sendMail({ to: candidate.email, subject: msg.subject, text: msg.body });
        await update({ status: 'sent', sentAt: new Date(), transport: info.transport, providerId: info.id, error: null });
        await logActivity({
          jobId: msg.jobId,
          candidateId: candidate._id,
          actor: msg.kind === 'reply' ? 'recruiter:ui' : 'system',
          type: msg.kind === 'reply' ? 'reply_sent' : 'email_sent',
          message: `${msg.kind === 'reply' ? 'Reply' : `Email step ${msg.stepIndex + 1}`} sent to ${candidate.name} (${info.transport})`,
        });
        if (msg.kind === 'outreach' && candidate.status === 'accepted') {
          await changeStatus(candidate._id, 'contacted', { actor: 'system', note: 'first email sent' });
        }
      }
    }
  } catch (err) {
    log.warn({ err, messageId: String(msg._id) }, 'send attempt failed');
    const error = err instanceof Error ? err.message : 'send failed';
    if (isLastAttempt(queueJob)) await update({ status: 'failed', error });
    else {
      await update({ status: 'scheduled', error });
      throw err;
    }
  }

  refresh('campaign', { jobId: msg.jobId, id: msg.campaignId });
  await completeCampaignIfFinished(msg.campaignId);
}

async function passesOutreachRules(
  msg: any,
  candidate: any,
  update: (patch: Record<string, unknown>) => Promise<unknown>,
  skip: (note: string) => Promise<unknown>,
) {
  if (msg.kind !== 'outreach') return true;

  const campaign = await Campaign.findById(msg.campaignId);
  if (!campaign || campaign.status !== 'active') {
    await update({ status: 'scheduled' });
    return false;
  }

  const expected = msg.stepIndex === 0 ? 'accepted' : 'contacted';
  if (candidate.status !== expected) {
    await skip(`candidate is ${candidate.status}`);
    return false;
  }

  if (await OutreachMessage.exists({ candidateId: candidate._id, kind: 'outreach', stepIndex: msg.stepIndex, status: 'sent' })) {
    await skip('this step was already sent');
    return false;
  }

  const sentToday = await OutreachMessage.countDocuments({
    campaignId: campaign._id,
    kind: 'outreach',
    status: 'sent',
    sentAt: { $gte: startOfToday() },
  });
  if (sentToday >= campaign.dailyLimit) {
    await update({ status: 'scheduled', scheduledFor: startOfTomorrow(), note: 'daily limit reached, moved to tomorrow' });
    return false;
  }
  return true;
}
