import { ActivityLog, Candidate, Job, LlmUsage, OutreachMessage, Reply } from '../models';
import { completeText } from '../lib/llm';
import { STATUS_LABEL } from '../lib/status';

const FUNNEL = ['sourced', 'accepted', 'contacted', 'replied', 'interested', 'meeting_booked', 'interviewed', 'shortlisted', 'hired'] as const;

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0);

export async function jobStats(jobId: unknown) {
  const [candidates, changes, usage, emailsSent, pendingReplyDrafts, repliesReceived] = await Promise.all([
    Candidate.find({ jobId }).select('status score').lean(),
    ActivityLog.find({ jobId, type: 'status_changed' }).select('candidateId to').lean(),
    LlmUsage.find({ jobId }).select('promptTokens completionTokens costUsd').lean(),
    OutreachMessage.countDocuments({ jobId, kind: 'outreach', status: 'sent' }),
    OutreachMessage.countDocuments({ jobId, kind: 'reply', status: 'draft' }),
    Reply.countDocuments({ jobId }),
  ]);

  const current: Record<string, number> = {};
  for (const c of candidates) current[c.status] = (current[c.status] || 0) + 1;

  // "reached" counts every candidate who ever entered a stage, so a rejected candidate still counts as contacted
  const reachedSets: Record<string, Set<string>> = {};
  for (const change of changes) {
    (reachedSets[change.to] ||= new Set()).add(String(change.candidateId));
  }
  const reached = (status: string) => (status === 'sourced' ? candidates.length : reachedSets[status]?.size || 0);

  const scores = candidates.map((c: any) => c.score).filter((s: unknown): s is number => typeof s === 'number');
  const contacted = reached('contacted');

  return {
    jobId: String(jobId),
    totalCandidates: candidates.length,
    funnel: FUNNEL.map((status) => ({ status, label: STATUS_LABEL[status], reached: reached(status), now: current[status] || 0 })),
    current,
    rejected: reached('rejected'),
    unsubscribed: reached('unsubscribed'),
    notInterested: reached('not_interested'),
    emailsSent,
    repliesReceived,
    pendingReplyDrafts,
    replyRate: ratio(reached('replied'), contacted),
    interestedRate: ratio(reached('interested'), contacted),
    meetings: reached('meeting_booked'),
    hires: reached('hired'),
    scoring: {
      scored: scores.length,
      average: scores.length ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length) : null,
      top: scores.length ? Math.max(...scores) : null,
    },
    cost: {
      calls: usage.length,
      promptTokens: usage.reduce((n: number, u: any) => n + u.promptTokens, 0),
      completionTokens: usage.reduce((n: number, u: any) => n + u.completionTokens, 0),
      usd: Math.round(usage.reduce((n: number, u: any) => n + u.costUsd, 0) * 10000) / 10000,
    },
  };
}

export async function listJobsWithStats() {
  const jobs = await Job.find().sort({ createdAt: -1 }).limit(50);
  return Promise.all(jobs.map(async (job: any) => ({ ...job.toJSON(), stats: await jobStats(job._id) })));
}

export async function summarizeJob(jobId: unknown) {
  const job = await Job.findById(jobId);
  if (!job) return '';
  const stats = await jobStats(jobId);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const facts = {
    role: job.title,
    candidates: stats.totalCandidates,
    funnelReached: Object.fromEntries(stats.funnel.map((f) => [f.label, f.reached])),
    emailsSent: stats.emailsSent,
    replyRate: pct(stats.replyRate),
    interestedRate: pct(stats.interestedRate),
    meetings: stats.meetings,
    hires: stats.hires,
    repliesWaitingForApproval: stats.pendingReplyDrafts,
    unsubscribed: stats.unsubscribed,
    averageScore: stats.scoring.average,
  };

  return completeText(
    'You write a short progress update on a hiring pipeline for a recruiter. Use only the numbers provided, never invent figures. ' +
      'Write 3 to 5 plain sentences: where the pipeline stands, what is going well, and the one thing to do next. No headings or bullet points.',
    JSON.stringify(facts),
    { purpose: 'job_summary', jobId },
    () =>
      `${job.title}: ${stats.totalCandidates} candidates sourced, ${stats.emailsSent} emails sent, reply rate ${pct(stats.replyRate)}, ` +
      `${stats.meetings} meetings booked and ${stats.hires} hired. ` +
      (stats.pendingReplyDrafts ? `${stats.pendingReplyDrafts} reply drafts are waiting for your approval.` : 'Nothing is waiting for approval.'),
  );
}
