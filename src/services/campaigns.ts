import { Campaign, Candidate, OutreachMessage } from '../models';
import { config } from '../config';
import { HttpError } from '../lib/http';
import { isEmail } from '../lib/csv';
import { refresh } from '../lib/events';
import { draftingQueue, sendingQueue } from '../queues';
import { logActivity, type Actor } from './activity';

export const UNSUBSCRIBE_FOOTER = '\n\n--\nIf you would rather not hear from me, just reply "unsubscribe" and I will not contact you again.';

export type StepInput = { dayOffset: number; goal: string };

export const DEFAULT_SEQUENCE: StepInput[] = [
  { dayOffset: 0, goal: 'Introduce the role and invite them to a short chat' },
  { dayOffset: 3, goal: 'Short, friendly follow-up in case the first email was missed' },
  { dayOffset: 7, goal: 'Final polite nudge, make it easy to say no' },
];

export const SINGLE_EMAIL: StepInput[] = [DEFAULT_SEQUENCE[0]];

export async function eligibleForOutreach(jobId: unknown, onlyIds?: string[]) {
  const query: Record<string, unknown> = { jobId, status: 'accepted' };
  if (onlyIds?.length) query._id = { $in: onlyIds };
  const accepted = await Candidate.find(query).sort({ score: -1 });

  const busy = new Set(
    (
      await OutreachMessage.distinct('candidateId', {
        jobId,
        kind: 'outreach',
        status: { $in: ['draft', 'scheduled', 'sending'] },
      })
    ).map(String),
  );

  const eligible: any[] = [];
  const noEmail: any[] = [];
  const alreadyQueued: any[] = [];
  for (const c of accepted) {
    if (!c.email || !isEmail(c.email)) noEmail.push(c);
    else if (busy.has(String(c._id))) alreadyQueued.push(c);
    else eligible.push(c);
  }
  return { eligible, noEmail, alreadyQueued };
}

export async function createCampaign(input: {
  jobId: string;
  conversationId?: unknown;
  name: string;
  steps: StepInput[];
  dailyLimit?: number;
  tone?: string;
  candidateIds?: string[];
}) {
  const { eligible } = await eligibleForOutreach(input.jobId, input.candidateIds);
  if (!eligible.length) {
    throw new HttpError(409, 'No accepted candidates with an email address are available for outreach');
  }

  const steps = [...input.steps].sort((a, b) => a.dayOffset - b.dayOffset);
  const campaign = await Campaign.create({
    jobId: input.jobId,
    conversationId: input.conversationId,
    name: input.name,
    steps,
    tone: input.tone,
    dailyLimit: input.dailyLimit || config.outreach.defaultDailyLimit,
    candidateIds: eligible.map((c) => c._id),
  });

  for (const c of eligible) {
    await draftingQueue.add('draft', { campaignId: String(campaign._id), candidateId: String(c._id) }, { jobId: `draft-${campaign._id}-${c._id}` });
  }
  await logActivity({
    jobId: input.jobId,
    actor: 'recruiter:chat',
    type: 'campaign_created',
    message: `Campaign "${campaign.name}" created for ${eligible.length} candidates (${steps.length} step${steps.length > 1 ? 's' : ''})`,
  });
  refresh('campaign', { jobId: input.jobId, id: campaign._id });
  return campaign;
}

export async function approveCampaign(campaignId: string, actor: Actor) {
  const drafts = await OutreachMessage.find({ campaignId, kind: 'outreach', status: 'draft' });
  if (!drafts.length) throw new HttpError(409, 'There are no drafts to send');
  const blank = drafts.find((d: any) => !d.subject.trim() || !d.body.trim());
  if (blank) throw new HttpError(400, 'Some drafts have an empty subject or body. Fill them in or skip them first.');

  const campaign = await Campaign.findOneAndUpdate(
    { _id: campaignId, status: 'ready' },
    { status: 'active', approvedAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!campaign) throw new HttpError(409, 'This campaign is not waiting for approval');

  const now = Date.now();
  for (const draft of drafts) {
    const step = campaign.steps[draft.stepIndex];
    await OutreachMessage.updateOne(
      { _id: draft._id, status: 'draft' },
      { status: 'scheduled', scheduledFor: new Date(now + (step?.dayOffset ?? 0) * config.outreach.dayMs) },
    );
  }

  await logActivity({
    jobId: campaign.jobId,
    actor,
    type: 'campaign_approved',
    message: `Campaign "${campaign.name}" approved, ${drafts.length} emails scheduled`,
  });
  refresh('campaign', { jobId: campaign.jobId, id: campaign._id });
  await enqueueDueMessages();
  return campaign;
}

export async function setCampaignPaused(campaignId: string, paused: boolean, actor: Actor) {
  const from = paused ? 'active' : 'paused';
  const campaign = await Campaign.findOneAndUpdate({ _id: campaignId, status: from }, { status: paused ? 'paused' : 'active' }, { returnDocument: 'after' });
  if (!campaign) throw new HttpError(409, `Campaign is not ${from}`);
  await logActivity({
    jobId: campaign.jobId,
    actor,
    type: paused ? 'campaign_paused' : 'campaign_resumed',
    message: `Campaign "${campaign.name}" ${paused ? 'paused' : 'resumed'}`,
  });
  refresh('campaign', { jobId: campaign.jobId, id: campaign._id });
  if (!paused) await enqueueDueMessages();
  return campaign;
}

// the database is the source of truth; this just hands due messages to the queue
export async function enqueueDueMessages() {
  const activeCampaigns = await Campaign.distinct('_id', { status: 'active' });
  const due = await OutreachMessage.find({
    status: 'scheduled',
    scheduledFor: { $lte: new Date() },
    $or: [{ kind: 'reply' }, { campaignId: { $in: activeCampaigns } }],
  })
    .sort({ scheduledFor: 1 })
    .limit(200)
    .select('_id');

  for (const m of due) {
    await sendingQueue.add('send', { messageId: String(m._id) }, { jobId: `send-${m._id}` });
  }
  return due.length;
}

export async function completeCampaignIfFinished(campaignId: unknown) {
  if (!campaignId) return;
  const open = await OutreachMessage.exists({ campaignId, status: { $in: ['draft', 'scheduled', 'sending'] } });
  if (open) return;
  const done = await Campaign.findOneAndUpdate({ _id: campaignId, status: 'active' }, { status: 'completed' }, { returnDocument: 'after' });
  if (done) {
    await logActivity({ jobId: done.jobId, actor: 'system', type: 'campaign_completed', message: `Campaign "${done.name}" finished` });
    refresh('campaign', { jobId: done.jobId, id: done._id });
  }
}
