
import type { Job as QueueJob } from 'bullmq';
import { z } from 'zod';
import { Candidate, Job } from '../models';
import { completeJson } from '../lib/llm';
import { UNTRUSTED_RULE, wrapUntrusted } from '../lib/sanitize';
import { refresh } from '../lib/events';
import { log } from '../logger';
import { isLastAttempt } from '../queues';
import { finishRunIfDone } from '../services/sourcing';

type JobData = {
  title: string;
  seniority?: string;
  location?: string;
  remotePolicy?: string;
  mustHaveSkills?: string[];
  niceToHaveSkills?: string[];
  summary?: string;
};

type CandidateData = {
  headline?: string;
  company?: string;
  location?: string;
  skills?: string[];
  snippet?: string;
  notes?: string;
};

const scoreSchema = z.object({
  score: z.number().min(0).max(100),
  reason: z.string().trim().min(1).max(500),
  matchedSkills: z.array(z.string()).default([]),
  missingSkills: z.array(z.string()).default([]),
  dataQuality: z.enum(['rich', 'thin']).default('thin'),
});

const SYSTEM = `You screen candidates for a recruiter.
Score how well one candidate fits one job from 0 to 100.

Rubric:
- Must-have skills: 55 points
- Seniority and relevant experience: 20 points
- Nice-to-have skills: 15 points
- Location or remote fit: 10 points

Rules:
- Use only what the profile text says.
- If something is not mentioned, treat it as unknown, not as present.
- Thin profiles (a one-line headline, no skills) cannot honestly score above 60.
- If the profile is thin, explain why and set dataQuality to "thin".
- reason: one or two plain sentences a recruiter can read quickly.
- Mention the strongest match and the biggest gap.
- matchedSkills and missingSkills must only contain skills from the job's must-have or nice-to-have lists.
- Do not invent skills, experience, or qualifications.
- The candidate's name is not provided on purpose.
- Do not guess identity, gender, age or nationality.

${UNTRUSTED_RULE}

Return JSON:
{
  "score": number,
  "reason": string,
  "matchedSkills": string[],
  "missingSkills": string[],
  "dataQuality": "rich" | "thin"
}`;

function getSkills(skills?: string[]): string[] {
  if (!Array.isArray(skills)) return [];

  return [
    ...new Set(
      skills
        .filter((skill) => typeof skill === 'string')
        .map((skill) => skill.trim())
        .filter(Boolean),
    ),
  ];
}

function describeJob(job: JobData): string {
  const mustHaveSkills = getSkills(job.mustHaveSkills);
  const niceToHaveSkills = getSkills(job.niceToHaveSkills);

  return [
    `Title: ${job.title}`,
    job.seniority && `Seniority: ${job.seniority}`,
    job.location && `Location: ${job.location}`,
    `Remote policy: ${job.remotePolicy || 'unspecified'}`,
    `Must-have skills: ${mustHaveSkills.join(', ') || 'none listed'}`,
    `Nice-to-have skills: ${niceToHaveSkills.join(', ') || 'none listed'}`,
    job.summary && `Summary: ${job.summary}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function describeCandidate(candidate: CandidateData): string {
  const skills = getSkills(candidate.skills);

  return [
    candidate.headline && `Headline: ${candidate.headline}`,
    candidate.company && `Company: ${candidate.company}`,
    candidate.location && `Location: ${candidate.location}`,
    skills.length > 0 && `Skills: ${skills.join(', ')}`,
    candidate.snippet && `Profile snippet: ${candidate.snippet}`,
    candidate.notes && `Notes: ${candidate.notes}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsSkill(text: string, skill: string): boolean {
  const normalizedSkill = skill.trim().toLowerCase();

  if (!normalizedSkill) return false;

  const pattern = new RegExp(
    `(^|[^a-z0-9+#.])${escapeRegex(normalizedSkill)}($|[^a-z0-9+#.])`,
    'i',
  );

  return pattern.test(text);
}

function heuristicScore(job: JobData, candidate: CandidateData) {
  const mustHaveSkills = getSkills(job.mustHaveSkills);
  const niceToHaveSkills = getSkills(job.niceToHaveSkills);

  const candidateText = [
    candidate.headline,
    candidate.company,
    candidate.location,
    candidate.snippet,
    candidate.notes,
    ...getSkills(candidate.skills),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const matchedMustHave = mustHaveSkills.filter((skill) =>
    containsSkill(candidateText, skill),
  );

  const missingMustHave = mustHaveSkills.filter(
    (skill) => !containsSkill(candidateText, skill),
  );

  const matchedNiceToHave = niceToHaveSkills.filter((skill) =>
    containsSkill(candidateText, skill),
  );

  const mustHaveScore = mustHaveSkills.length
    ? (matchedMustHave.length / mustHaveSkills.length) * 55
    : 0;

  const niceToHaveScore = niceToHaveSkills.length
    ? (matchedNiceToHave.length / niceToHaveSkills.length) * 15
    : 0;

  const experienceScore = 0;

  const remotePolicy = job.remotePolicy?.toLowerCase();
  const candidateLocation = candidate.location?.trim().toLowerCase();
  const jobLocation = job.location?.trim().toLowerCase();

  let locationScore = 0;

  if (remotePolicy === 'remote') {
    locationScore = 10;
  } else if (
    candidateLocation &&
    jobLocation &&
    candidateLocation === jobLocation
  ) {
    locationScore = 10;
  }

  const profileLength = candidateText.trim().length;
  const dataQuality = profileLength > 120 ? 'rich' : 'thin';

  let score = Math.round(
    mustHaveScore + niceToHaveScore + experienceScore + locationScore,
  );

  if (dataQuality === 'thin') {
    score = Math.min(score, 60);
  }

  const matchedSkills = [
    ...matchedMustHave,
    ...matchedNiceToHave,
  ];

  return {
    score,
    reason:
      `Keyword-based assessment: matches ${matchedMustHave.length} of ` +
      `${mustHaveSkills.length} must-have skills. ` +
      'Experience and seniority could not be verified from the available profile data.',
    matchedSkills,
    missingSkills: missingMustHave,
    dataQuality,
  };
}

function normalizeSkillResults(
  result: z.infer<typeof scoreSchema>,
  job: JobData,
) {
  const allowedSkills = [
    ...getSkills(job.mustHaveSkills),
    ...getSkills(job.niceToHaveSkills),
  ];

  const allowedMap = new Map(
    allowedSkills.map((skill) => [skill.toLowerCase(), skill]),
  );

  const matched = new Set<string>();

  const matchedSkills = result.matchedSkills
    .map((skill) => allowedMap.get(skill.trim().toLowerCase()))
    .filter((skill): skill is string => Boolean(skill))
    .filter((skill) => {
      const key = skill.toLowerCase();

      if (matched.has(key)) return false;

      matched.add(key);
      return true;
    });

  const missing = new Set<string>();

  const missingSkills = result.missingSkills
    .map((skill) => allowedMap.get(skill.trim().toLowerCase()))
    .filter((skill): skill is string => Boolean(skill))
    .filter((skill) => {
      const key = skill.toLowerCase();

      if (matched.has(key) || missing.has(key)) return false;

      missing.add(key);
      return true;
    });

  return {
    ...result,
    score: Math.round(result.score),
    matchedSkills,
    missingSkills,
  };
}

export async function processScoring(
  queueJob: QueueJob<{ candidateId: string; runId: string }>,
) {
  const { candidateId, runId } = queueJob.data;

  const candidate = await Candidate.findById(candidateId);

  if (!candidate || candidate.score != null) {
    return;
  }

  const job = await Job.findById(candidate.jobId);

  if (!job) {
    log.warn({ candidateId, runId }, 'job not found for candidate');

    refresh('run', { jobId: candidate.jobId, id: runId });
    await finishRunIfDone(runId);
    return;
  }

  try {

    const result = await completeJson(scoreSchema, {
      system: SYSTEM,
      user:
        `JOB\n${describeJob(job)}\n\n` +
        `CANDIDATE\n${wrapUntrusted('profile', describeCandidate(candidate))}`,
      ctx: { purpose: 'score', jobId: job._id },
      fallback: () => heuristicScore(job, candidate),
    });

    const validatedResult = scoreSchema.parse(result);

    const normalizedResult = normalizeSkillResults(validatedResult, job);

    const update = await Candidate.updateOne(
      { _id: candidate._id, score: null },
      {
        $set: {
          score: normalizedResult.score,
          scoreReason: normalizedResult.reason,
          matchedSkills: normalizedResult.matchedSkills,
          missingSkills: normalizedResult.missingSkills,
          dataQuality: normalizedResult.dataQuality,
        },
        $unset: {
          scoreError: 1,
        },
      },
    );

    if (update.modifiedCount === 0) {
      log.info(
        { candidateId },
        'candidate score was already updated by another worker',
      );
    }
  } catch (err) {
    log.warn({ err, candidateId }, 'scoring attempt failed');

    if (!isLastAttempt(queueJob)) {
      throw err;
    }

    await Candidate.updateOne(
      { _id: candidate._id, score: null },
      {
        $set: {
          scoreError:
            err instanceof Error ? err.message : 'Scoring failed',
        },
      },
    );
  }

  refresh('run', { jobId: candidate.jobId, id: runId });
  refresh('candidate', { jobId: candidate.jobId });

  await finishRunIfDone(runId);
}
