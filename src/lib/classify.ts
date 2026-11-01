import { z } from 'zod';

export const LABELS = ['interested', 'not_interested', 'question', 'wants_meeting', 'unsubscribe'] as const;

export const classifySchema = z.object({
  // small models sometimes answer "Wants Meeting" or 90 instead of 0.9, so be forgiving
  label: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') : v), z.enum(LABELS)),
  confidence: z.preprocess((v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && n > 1 && n <= 100 ? n / 100 : n;
  }, z.number().min(0).max(1)),
  rationale: z.preprocess((v) => (typeof v === 'string' ? v.slice(0, 300) : ''), z.string()).default(''),
});

export const STOP_WORDS = /\b(unsubscribe|stop (emailing|contacting|messaging)|remove me|take me off|do not contact|don'?t contact)\b/i;

export function heuristicLabel(text: string) {
  const t = text.toLowerCase();
  if (STOP_WORDS.test(t)) return { label: 'unsubscribe' as const, confidence: 0.9, rationale: 'keyword match' };
  if (/\b(not interested|no thanks|not looking|pass on|decline)\b/.test(t)) return { label: 'not_interested' as const, confidence: 0.85, rationale: 'keyword match' };
  if (/\b(call|meet|schedule|book a|time to talk|chat|(i am|i'm|are you|we are) (free|available))\b/.test(t)) return { label: 'wants_meeting' as const, confidence: 0.85, rationale: 'keyword match' };
  if (t.includes('?')) return { label: 'question' as const, confidence: 0.8, rationale: 'contains a question' };
  return { label: 'interested' as const, confidence: 0.7, rationale: 'default positive' };
}

