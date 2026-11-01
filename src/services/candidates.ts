import { Candidate, type Status } from '../models';
import { canMove, STATUS_LABEL } from '../lib/status';

type Selector = {
  jobId: string;
  names?: string[];
  ids?: string[];
  topN?: number;
  minScore?: number;
  fromStatus?: Status;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function findOneByName(jobId: string, name: string, status?: Status) {
  const query: Record<string, unknown> = { jobId, name: new RegExp(escapeRegex(name.trim()), 'i') };
  if (status) query.status = status;
  const matches = await Candidate.find(query).limit(6);
  if (matches.length === 1) return { candidate: matches[0] };
  if (!matches.length) return { error: `No ${status ? `${STATUS_LABEL[status]} ` : ''}candidate matches "${name}"` };
  return { error: `"${name}" matches several people: ${matches.map((m: any) => m.name).join(', ')}. Ask which one.` };
}

// the model never picks database ids itself
export async function selectCandidates(sel: Selector, to: Status) {
  const picked: any[] = [];
  const problems: string[] = [];

  for (const id of sel.ids || []) {
    const c = await Candidate.findOne({ _id: id, jobId: sel.jobId }).catch(() => null);
    if (c) picked.push(c);
    else problems.push(`No candidate with id ${id} in this job`);
  }

  for (const name of sel.names || []) {
    const matches = await Candidate.find({ jobId: sel.jobId, name: new RegExp(escapeRegex(name.trim()), 'i') }).limit(6);
    if (!matches.length) problems.push(`No candidate matches "${name}"`);
    else if (matches.length > 1) problems.push(`"${name}" matches several people: ${matches.map((m: any) => m.name).join(', ')}. Ask which one.`);
    else picked.push(matches[0]);
  }

  const usesFilter = sel.topN != null || sel.minScore != null || sel.fromStatus != null;
  if (usesFilter) {
    const from = sel.fromStatus || (to === 'accepted' || to === 'rejected' ? 'sourced' : undefined);
    const query: Record<string, unknown> = { jobId: sel.jobId };
    if (from) query.status = from;
    if (sel.minScore != null) query.score = { $gte: sel.minScore };
    else query.score = { $ne: null };
    picked.push(...(await Candidate.find(query).sort({ score: -1 }).limit(sel.topN ?? 200)));
  }

  const unique = [...new Map(picked.map((c) => [String(c._id), c])).values()];
  const valid = unique.filter((c) => canMove(c.status, to) || c.status === to);
  const blocked = unique
    .filter((c) => !valid.includes(c))
    .map((c) => ({ name: c.name, reason: `is ${STATUS_LABEL[c.status as Status]}, which cannot move to ${STATUS_LABEL[to]}` }));

  return { valid: valid.filter((c) => c.status !== to), blocked, problems, unchanged: valid.filter((c) => c.status === to).map((c: any) => c.name) };
}
