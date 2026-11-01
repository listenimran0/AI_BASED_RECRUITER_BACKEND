export const STATUSES = [
  'sourced',
  'accepted',
  'rejected',
  'contacted',
  'replied',
  'interested',
  'not_interested',
  'meeting_booked',
  'interviewed',
  'shortlisted',
  'hired',
  'unsubscribed',
] as const;
export type Status = (typeof STATUSES)[number];

export type CardRef = { type: string; ref: Record<string, unknown> };
