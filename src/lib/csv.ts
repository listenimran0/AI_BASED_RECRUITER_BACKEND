import { parse } from 'csv-parse/sync';

export type CsvCandidate = {
  name: string;
  email?: string;
  profileUrl?: string;
  headline?: string;
  company?: string;
  location?: string;
  skills: string[];
  notes?: string;
};

const ALIASES: Record<string, string[]> = {
  name: ['name', 'full_name', 'fullname', 'candidate', 'candidate_name'],
  firstName: ['first_name', 'firstname', 'first'],
  lastName: ['last_name', 'lastname', 'last', 'surname'],
  email: ['email', 'email_address', 'e-mail', 'mail'],
  profileUrl: ['profile_url', 'profile', 'linkedin', 'linkedin_url', 'url', 'link'],
  headline: ['headline', 'title', 'current_title', 'job_title', 'role', 'position'],
  company: ['company', 'current_company', 'employer', 'organization'],
  location: ['location', 'city', 'country'],
  skills: ['skills', 'skill', 'tags', 'tech'],
  notes: ['notes', 'note', 'summary', 'about', 'comments'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string) {
  return EMAIL_RE.test(value);
}

function pick(row: Record<string, string>, field: keyof typeof ALIASES) {
  for (const alias of ALIASES[field]) {
    const value = row[alias];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseCandidateCsv(content: string) {
  const records = parse(content, {
    columns: (header: string[]) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  }) as Record<string, string>[];

  const rows: CsvCandidate[] = [];
  const skipped: { line: number; reason: string }[] = [];

  records.forEach((row, i) => {
    const line = i + 2;
    const name = pick(row, 'name') || [pick(row, 'firstName'), pick(row, 'lastName')].filter(Boolean).join(' ');
    const email = pick(row, 'email')?.toLowerCase();
    if (!name) return skipped.push({ line, reason: 'missing name' });
    if (email && !isEmail(email)) return skipped.push({ line, reason: `invalid email "${email}"` });

    const profileUrl = pick(row, 'profileUrl');
    if (!email && !profileUrl) return skipped.push({ line, reason: 'needs an email or a profile url' });

    rows.push({
      name,
      email,
      profileUrl,
      headline: pick(row, 'headline'),
      company: pick(row, 'company'),
      location: pick(row, 'location'),
      skills: (pick(row, 'skills') || '')
        .split(/[;,|]/)
        .map((s) => s.trim())
        .filter(Boolean),
      notes: pick(row, 'notes'),
    });
  });

  return { rows, skipped };
}
