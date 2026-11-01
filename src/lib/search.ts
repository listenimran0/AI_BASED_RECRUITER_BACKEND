
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config';
import { log } from '../logger';

export type SearchHit = {
  title: string;
  link: string;
  snippet: string;
};

export type ParsedProfile = {
  name: string;
  headline: string;
  profileUrl: string;
  snippet: string;
};

type JobLike = {
  title: string;
  seniority?: string;
  location?: string;
  remotePolicy?: string;
  mustHaveSkills?: string[];
};

export const usingMockSearch = !config.serperKey;

const SEED_DIR = path.resolve(__dirname, '../../seed');

const SERPER_URL = 'https://google.serper.dev/search';
const SEARCH_RESULTS_PER_PAGE = 10;
const SEARCH_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSearchHit(value: unknown): value is SearchHit {
  if (!isRecord(value)) return false;

  return (
    typeof value.title === 'string' &&
    typeof value.link === 'string' &&
    typeof value.snippet === 'string'
  );
}

export async function searchWeb(
  query: string,
  page: number
): Promise<SearchHit[]> {
  if (usingMockSearch) {
    return mockSearch(page);
  }

  if (!query.trim()) {
    throw new Error('Search query cannot be empty');
  }

  if (!Number.isInteger(page) || page < 1) {
    throw new Error('Search page must be a positive integer');
  }

  const res = await fetch(SERPER_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': config.serperKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: SEARCH_RESULTS_PER_PAGE,
      page,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Serper responded with HTTP ${res.status}`);
  }

  const data: unknown = await res.json();

  if (!isRecord(data)) {
    throw new Error('Invalid Serper response format');
  }

  const organic = data.organic;

  if (!Array.isArray(organic)) {
    return [];
  }

  return organic
    .filter(isRecord)
    .map((item) => ({
      title: normalizeText(item.title),
      link: normalizeText(item.link),
      snippet: normalizeText(item.snippet),
    }));
}

function mockSearch(page: number): SearchHit[] {
  if (page > 1) return [];

  const fixturePath = path.join(SEED_DIR, 'mock-search.json');

  try {
    const content = fs.readFileSync(fixturePath, 'utf8');
    const data: unknown = JSON.parse(content);

    if (!Array.isArray(data)) {
      throw new Error('Mock search fixture must contain an array');
    }

    const invalidItems = data.filter((item) => !isSearchHit(item));

    if (invalidItems.length > 0) {
      throw new Error(
        `Mock search fixture contains ${invalidItems.length} invalid items`
      );
    }

    return data;
  } catch (err) {
    log.warn({ err, fixturePath }, 'mock search fixture unavailable');
    return [];
  }
}

export function normalizeProfileUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());

    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    const hostname = url.hostname.toLowerCase();

    const isLinkedIn =
      hostname === 'linkedin.com' ||
      hostname.endsWith('.linkedin.com');

    if (!isLinkedIn) {
      return null;
    }

    const pathname = url.pathname
      .replace(/\/+$/, '')
      .toLowerCase();

    if (!/^\/in\/[^/]+$/.test(pathname)) {
      return null;
    }

    return `linkedin.com${pathname}`;
  } catch {
    return null;
  }
}

export function parseLinkedInHit(
  hit: SearchHit
): ParsedProfile | null {
  const normalizedUrl = normalizeProfileUrl(hit.link);

  if (!normalizedUrl) {
    return null;
  }

  const cleanTitle = hit.title
    .replace(/\s*[|–-]\s*LinkedIn\s*$/i, '')
    .trim();

  if (!cleanTitle) {
    return null;
  }

  const [rawName, ...headlineParts] = cleanTitle.split(
    /\s+[-–|]\s+/
  );

  const name = rawName?.trim();

  if (!name || name.length < 2) {
    return null;
  }

  return {
    name,
    headline: headlineParts.join(' - ').trim(),
    profileUrl: `https://${normalizedUrl}`,
    snippet: hit.snippet.trim(),
  };
}

export function buildQueries(job: JobLike): string[] {
  const title = job.title.trim();

  if (!title) {
    return [];
  }

  const skills = [
    ...new Set(
      (job.mustHaveSkills ?? [])
        .map((skill) => skill.trim())
        .filter(Boolean)
        .map((skill) => skill.slice(0, 100))
    ),
  ].slice(0, 3);

  const seniority = job.seniority?.trim() ?? '';
  const location = job.location?.trim() ?? '';
  const remotePolicy = job.remotePolicy?.trim().toLowerCase();

  const place =
    location && remotePolicy !== 'remote'
      ? `"${location}"`
      : '';

  const base = 'site:linkedin.com/in';

  const queries = [
    [
      base,
      `"${title}"`,
      ...skills.slice(0, 2).map((skill) => `"${skill}"`),
      place,
    ],

    [
      base,
      seniority,
      title,
      place,
    ],

    [
      base,
      ...skills.map((skill) => `"${skill}"`),
      place,
    ],
  ];

  return [
    ...new Set(
      queries
        .map((parts) => parts.filter(Boolean).join(' ').trim())
        .filter(Boolean)
    ),
  ];
}
