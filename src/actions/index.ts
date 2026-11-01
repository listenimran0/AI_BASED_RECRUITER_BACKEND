import { z, type ZodType } from 'zod';
import { Conversation, Job, PendingAction, STATUSES, type CardRef } from '../models';
import { HttpError, parse } from '../lib/http';
import { refresh } from '../lib/events';
import { STATUS_LABEL } from '../lib/status';
import { changeStatus, logActivity } from '../services/activity';
import { approveCampaign, createCampaign, setCampaignPaused } from '../services/campaigns';
import { postAssistant } from '../services/chat';
import { startWebSourcing } from '../services/sourcing';

export const jobPayload = z.object({
  title: z.string().trim().min(2).max(120),
  seniority: z.string().trim().max(60).optional(),
  location: z.string().trim().max(120).optional(),
  remotePolicy: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).default('unknown'),
  salaryText: z.string().trim().max(120).optional(),
  salaryMin: z.number().positive().optional(),
  salaryMax: z.number().positive().optional(),
  salaryCurrency: z.string().trim().max(8).optional(),
  mustHaveSkills: z.array(z.string().trim().min(1).max(60)).max(25).default([]),
  niceToHaveSkills: z.array(z.string().trim().min(1).max(60)).max(25).default([]),
  summary: z.string().trim().max(1200).optional(),
  sourceUrl: z.string().trim().max(500).optional(),
});

const stepSchema = z.object({
  dayOffset: z.number().int().min(0).max(60),
  goal: z.string().trim().min(3).max(200),
});

type Executor<T> = {
  schema: ZodType<T>;
  run: (payload: T, ctx: { conversationId: string }) => Promise<unknown>;
};

const define = <T>(e: Executor<T>) => e as Executor<any>;

const executors: Record<string, Executor<any>> = {
  create_job: define({
    schema: jobPayload,
    run: async (p, { conversationId }) => {
      const { salaryText, salaryMin, salaryMax, salaryCurrency, ...rest } = p;
      const hasSalary = salaryText || salaryMin || salaryMax;
      const job = await Job.create({
        ...rest,
        conversationId,
        salary: hasSalary ? { text: salaryText, min: salaryMin, max: salaryMax, currency: salaryCurrency } : undefined,
      });
      await Conversation.updateOne({ _id: conversationId }, { activeJobId: job._id });
      await logActivity({ jobId: job._id, actor: 'recruiter:chat', type: 'job_created', message: `Job "${job.title}" created` });
      await postAssistant(
        conversationId,
        `Created the **${job.title}** job. Next I can look for candidates on the web, or you can upload a CSV with the paperclip button. Want me to start sourcing?`,
        [
          { type: 'job', ref: { jobId: String(job._id) } },
          { type: 'suggestions', ref: { items: ['Start sourcing for this job'] } },
        ],
      );
      return { jobId: String(job._id) };
    },
  }),

  start_sourcing: define({
    schema: z.object({ jobId: z.string(), target: z.number().int().min(5).max(100).default(30) }),
    run: async (p, { conversationId }) => {
      const run = await startWebSourcing(p.jobId, conversationId, p.target);
      await postAssistant(conversationId, 'Sourcing is running in the background. You can keep chatting while it works.', [
        { type: 'run', ref: { runId: String(run._id) } },
      ]);
      return { runId: String(run._id) };
    },
  }),

  update_status: define({
    schema: z.object({
      jobId: z.string(),
      status: z.enum(STATUSES),
      candidateIds: z.array(z.string()).min(1).max(200),
      note: z.string().max(200).optional(),
    }),
    run: async (p, { conversationId }) => {
      const done: string[] = [];
      const failed: string[] = [];
      for (const id of p.candidateIds) {
        try {
          const { candidate } = await changeStatus(id, p.status, { actor: 'recruiter:chat', note: p.note });
          done.push(candidate.name);
        } catch (err) {
          failed.push(err instanceof HttpError ? err.message : 'unexpected error');
        }
      }
      const label = STATUS_LABEL[p.status];
      let text = done.length ? `Marked ${done.length} candidate${done.length > 1 ? 's' : ''} as **${label}**: ${done.join(', ')}.` : 'No statuses were changed.';
      if (failed.length) text += `\n\nCould not update: ${failed.join('; ')}.`;
      const suggestions =
        p.status === 'accepted' ? ['Create an outreach campaign for the accepted candidates'] : p.status === 'hired' ? ['How is this job going?'] : [];
      await postAssistant(conversationId, text, suggestions.length ? [{ type: 'suggestions', ref: { items: suggestions } }] : []);
      return { done, failed };
    },
  }),

  create_campaign: define({
    schema: z.object({
      jobId: z.string(),
      name: z.string().trim().min(2).max(100),
      steps: z.array(stepSchema).min(1).max(5),
      dailyLimit: z.number().int().min(1).max(500).default(20),
      tone: z.string().trim().max(100).optional(),
      candidateIds: z.array(z.string()).min(1).max(500),
    }),
    run: async (p, { conversationId }) => {
      const campaign = await createCampaign({ ...p, conversationId });
      await postAssistant(
        conversationId,
        `Writing personalised emails for ${campaign.candidateIds.length} candidate${campaign.candidateIds.length > 1 ? 's' : ''}. I will let you know when the drafts are ready.`,
      );
      return { campaignId: String(campaign._id) };
    },
  }),

  approve_campaign: define({
    schema: z.object({ campaignId: z.string() }),
    run: async (p, { conversationId }) => {
      const campaign = await approveCampaign(p.campaignId, 'recruiter:chat');
      await postAssistant(
        conversationId,
        'Approved. The emails are queued: the first step goes out now (within the daily limit) and follow-ups are scheduled. Anyone who replies or unsubscribes is removed from the sequence automatically.',
        [{ type: 'campaign', ref: { campaignId: String(campaign._id) } }],
      );
      return { campaignId: String(campaign._id) };
    },
  }),

  campaign_control: define({
    schema: z.object({ campaignId: z.string(), action: z.enum(['pause', 'resume']) }),
    run: async (p, { conversationId }) => {
      const campaign = await setCampaignPaused(p.campaignId, p.action === 'pause', 'recruiter:chat');
      await postAssistant(conversationId, `Campaign **${campaign.name}** is now ${p.action === 'pause' ? 'paused. Nothing more will be sent until you resume it' : 'running again'}.`);
      return { status: campaign.status };
    },
  }),

  set_auto_reply: define({
    schema: z.object({ jobId: z.string(), enabled: z.boolean() }),
    run: async (p, { conversationId }) => {
      const job = await Job.findByIdAndUpdate(p.jobId, { autoReply: p.enabled }, { returnDocument: 'after' });
      if (!job) throw new HttpError(404, 'Job not found');
      await logActivity({ jobId: job._id, actor: 'recruiter:chat', type: 'auto_reply_changed', message: `Auto-reply ${p.enabled ? 'enabled' : 'disabled'}` });
      refresh('job', { jobId: job._id });
      await postAssistant(
        conversationId,
        p.enabled
          ? 'Auto-reply is on for this job. I will only send a reply by myself for confident "interested" or "wants a meeting" messages that pass the safety checks. Everything else still waits for you.'
          : 'Auto-reply is off. Every reply draft will wait for your approval.',
      );
      return { autoReply: p.enabled };
    },
  }),
};

export async function createAction(conversationId: string, type: string, title: string, payload: Record<string, unknown>): Promise<CardRef> {
  const executor = executors[type];
  if (!executor) throw new Error(`Unknown action type ${type}`);
  const action = await PendingAction.create({ conversationId, type, title, payload });
  return { type: 'action', ref: { actionId: String(action._id) } };
}

export async function confirmAction(actionId: string, edits?: Record<string, unknown>) {
  const action = await PendingAction.findById(actionId);
  if (!action) throw new HttpError(404, 'Action not found');
  if (action.status !== 'pending') throw new HttpError(409, `This action is already ${action.status}`);

  const executor = executors[action.type];
  const payload = parse(executor.schema, { ...action.payload, ...(edits || {}) });

  const claimed = await PendingAction.findOneAndUpdate({ _id: actionId, status: 'pending' }, { status: 'running', payload: { ...action.payload, ...payload } }, { returnDocument: 'after' });
  if (!claimed) throw new HttpError(409, 'This action was already handled');
  refresh('action', { id: actionId });

  try {
    const result = await executor.run(payload, { conversationId: String(claimed.conversationId) });
    await PendingAction.updateOne({ _id: actionId }, { status: 'done', result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong';
    await PendingAction.updateOne({ _id: actionId }, { status: 'failed', error: message });
    refresh('action', { id: actionId });
    throw err instanceof HttpError ? err : new HttpError(500, message);
  }
  refresh('action', { id: actionId });
  return PendingAction.findById(actionId);
}

export async function cancelAction(actionId: string) {
  const action = await PendingAction.findOneAndUpdate({ _id: actionId, status: 'pending' }, { status: 'cancelled' }, { returnDocument: 'after' });
  if (!action) throw new HttpError(409, 'This action was already handled');
  refresh('action', { id: actionId });
  return action;
}

export async function actionPreview(actionId: string) {
  const action = await PendingAction.findById(actionId);
  if (!action) throw new HttpError(404, 'Action not found');
  return action;
}
