import type { Job as QueueJob } from 'bullmq';
import { z } from 'zod';
import { Campaign, Candidate, Job, OutreachMessage } from '../models';
import { config } from '../config';
import { completeJson } from '../lib/llm';
import { UNTRUSTED_RULE, wrapUntrusted } from '../lib/sanitize';
import { refresh } from '../lib/events';
import { log } from '../logger';
import { isLastAttempt } from '../queues';
import { UNSUBSCRIBE_FOOTER } from '../services/campaigns';
import { postAssistant } from '../services/chat';
import { logActivity } from '../services/activity';

const draftSchema = z.object({
  emails: z.array(z.object({ subject: z.string().min(1).max(150), body: z.string().min(1).max(2500) })).min(1),
});

export function salaryLine(job: any) {
  const s = job.salary || {};
  if (s.text) return s.text;
  if (s.min || s.max) return `${s.currency || ''} ${[s.min, s.max].filter(Boolean).join(' - ')}${s.period ? ` per ${s.period}` : ''}`.trim();
  return '';
}

const SYSTEM = `You write recruiting outreach emails on behalf of a recruiter. Write one email per step for one candidate.

Rules:
- Plain text only, no markdown. Address the candidate by first name.
- Step 1 is under 120 words. Follow-ups are under 70 words and must not repeat the first email word for word.
- Mention one specific detail from the candidate's profile only if the profile actually states it. If the profile is thin, keep it simple instead of flattering.
- Use only facts from the job description provided. Do not invent salary, benefits, team size, company facts, deadlines or promises.
- Mention salary only if the job data includes it.
- Do not say you have spoken before. Do not add an unsubscribe line (it is added automatically).
- Sign off with the recruiter name given.
${UNTRUSTED_RULE}

Return JSON: {"emails": [{"subject": string, "body": string}]} with exactly one entry per step, in order.`;

function fallbackEmails(job: any, candidate: any, steps: any[], recruiter: string) {
  const first = candidate.name.split(' ')[0];
  const role = job.title;
  const where = config.recruiter.company ? ` at ${config.recruiter.company}` : '';
  return steps.map((step, i) => ({
    subject: i === 0 ? `${role} opportunity${where}` : `Re: ${role} opportunity${where}`,
    body:
      i === 0
        ? `Hi ${first},\n\nI am hiring for a ${role}${where} and your background looked relevant. Would you be open to a short chat this week?\n\nBest,\n${recruiter}`
        : `Hi ${first},\n\nJust following up on my note about the ${role} role. Happy to share more if it sounds interesting, and no worries if not.\n\nBest,\n${recruiter}`,
  }));
}

export async function processDrafting(queueJob: QueueJob<{ campaignId: string; candidateId: string }>) {
  const { campaignId, candidateId } = queueJob.data;
  const campaign = await Campaign.findById(campaignId);
  const candidate = await Candidate.findById(candidateId);
  if (!campaign || !candidate) return;
  const job = await Job.findById(campaign.jobId);
  if (!job) return;

  const already = await OutreachMessage.exists({ campaignId, candidateId, kind: 'outreach' });
  if (!already) {
    try {
      const profile = [
        candidate.headline && `Headline: ${candidate.headline}`,
        candidate.company && `Company: ${candidate.company}`,
        candidate.location && `Location: ${candidate.location}`,
        candidate.matchedSkills?.length && `Skills that match the role: ${candidate.matchedSkills.join(', ')}`,
        candidate.snippet && `Profile snippet: ${candidate.snippet}`,
      ]
        .filter(Boolean)
        .join('\n');

      const result = await completeJson(draftSchema, {
        system: SYSTEM,
        user: [
          `Recruiter name: ${config.recruiter.name}`,
          config.recruiter.company ? `Company: ${config.recruiter.company}` : 'Company name: not provided, do not mention one',
          campaign.tone ? `Tone: ${campaign.tone}` : 'Tone: warm and professional',
          '',
          'JOB',
          `Title: ${job.title}`,
          job.seniority && `Seniority: ${job.seniority}`,
          job.location && `Location: ${job.location} (${job.remotePolicy})`,
          `Key skills: ${job.mustHaveSkills.join(', ')}`,
          salaryLine(job) && `Salary: ${salaryLine(job)}`,
          job.summary && `Summary: ${job.summary}`,
          '',
          'STEPS',
          ...campaign.steps.map((s: any, i: number) => `${i + 1}. Day ${s.dayOffset}: ${s.goal}`),
          '',
          'CANDIDATE',
          `First name: ${candidate.name.split(' ')[0]}`,
          wrapUntrusted('profile', profile || 'No profile details available'),
        ]
          .filter((l) => l !== undefined && l !== false)
          .join('\n'),
        ctx: { purpose: 'draft_outreach', jobId: job._id },
        fallback: () => ({ emails: fallbackEmails(job, candidate, campaign.steps, config.recruiter.name) }),
      });

      if (result.emails.length !== campaign.steps.length) throw new Error('Wrong number of emails returned');

      for (let i = 0; i < result.emails.length; i++) {
        const email = result.emails[i];
        await OutreachMessage.updateOne(
          { uniqueKey: `${campaignId}:${candidateId}:${i}` },
          {
            $setOnInsert: {
              campaignId,
              jobId: job._id,
              candidateId,
              kind: 'outreach',
              stepIndex: i,
              uniqueKey: `${campaignId}:${candidateId}:${i}`,
              subject: email.subject.trim(),
              body: email.body.trim() + UNSUBSCRIBE_FOOTER,
              status: 'draft',
            },
          },
          { upsert: true },
        );
      }
    } catch (err) {
      log.warn({ err, candidateId }, 'draft attempt failed');
      if (!isLastAttempt(queueJob)) throw err;
      try {
        // model kept failing: save the plain template so the candidate is not dropped
        const emails = fallbackEmails(job, candidate, campaign.steps, config.recruiter.name);
        for (let i = 0; i < emails.length; i++) {
          await OutreachMessage.updateOne(
            { uniqueKey: `${campaignId}:${candidateId}:${i}` },
            {
              $setOnInsert: {
                campaignId, jobId: job._id, candidateId, kind: 'outreach', stepIndex: i,
                uniqueKey: `${campaignId}:${candidateId}:${i}`,
                subject: emails[i].subject, body: emails[i].body + UNSUBSCRIBE_FOOTER, status: 'draft',
              },
            },
            { upsert: true },
          );
        }
      } catch (fallbackErr) {
        log.warn({ err: fallbackErr, candidateId }, 'template draft failed too');
        await Campaign.updateOne({ _id: campaignId }, { $inc: { draftsFailed: 1 } });
      }
    }
  }

  refresh('campaign', { jobId: job._id, id: campaignId });
  await finishDraftingIfDone(campaignId);
}

async function finishDraftingIfDone(campaignId: string) {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign || campaign.status !== 'drafting') return;
  const drafted = (await OutreachMessage.distinct('candidateId', { campaignId, kind: 'outreach' })).length;
  if (drafted + campaign.draftsFailed < campaign.candidateIds.length) return;

  const nextStatus = drafted ? 'ready' : 'failed';
  const won = await Campaign.findOneAndUpdate({ _id: campaignId, status: 'drafting' }, { status: nextStatus, draftsDone: drafted }, { returnDocument: 'after' });
  if (!won) return;
  refresh('campaign', { jobId: won.jobId, id: won._id });
  await logActivity({ jobId: won.jobId, actor: 'ai', type: 'drafts_ready', message: `Drafted emails for ${drafted} candidates in "${won.name}"` });

  if (!won.conversationId) return;
  if (!drafted) {
    await postAssistant(won.conversationId, 'I could not draft any emails for this campaign. Please try again in a moment.');
    return;
  }
  const missed = won.draftsFailed ? ` ${won.draftsFailed} candidate(s) failed to draft and were left out.` : '';
  await postAssistant(
    won.conversationId,
    `Drafts are ready for **${drafted}** candidate${drafted > 1 ? 's' : ''}.${missed} Read through them, edit anything you like, then approve. Nothing is sent until you do.`,
    [{ type: 'campaign', ref: { campaignId: String(won._id) } }],
  );
}
