import { STATUSES, type Status } from '../models';

const afterContact: Status[] = [
  'contacted',
  'replied',
  'interested',
  'not_interested',
  'meeting_booked',
  'interviewed',
  'shortlisted',
];

// allowed moves. Unsubscribed is added below for every status after "contacted".
const base: Record<Status, Status[]> = {
  sourced: ['accepted', 'rejected'],
  accepted: ['contacted', 'rejected'],
  contacted: ['replied', 'rejected'],
  replied: ['interested', 'not_interested', 'rejected'],
  interested: ['meeting_booked', 'not_interested', 'rejected'],
  not_interested: ['interested'],
  meeting_booked: ['interviewed', 'rejected'],
  interviewed: ['shortlisted', 'rejected'],
  shortlisted: ['hired', 'rejected'],
  hired: [],
  rejected: [],
  unsubscribed: [],
};

export const transitions: Record<Status, Status[]> = Object.fromEntries(
  STATUSES.map((s) => [s, afterContact.includes(s) ? [...base[s], 'unsubscribed' as Status] : base[s]]),
) as Record<Status, Status[]>;

export function canMove(from: Status, to: Status) {
  return transitions[from]?.includes(to) ?? false;
}

export const STOPS_OUTREACH: Status[] = [
  'replied',
  'interested',
  'not_interested',
  'meeting_booked',
  'interviewed',
  'shortlisted',
  'hired',
  'rejected',
  'unsubscribed',
];

export const STATUS_LABEL: Record<Status, string> = {
  sourced: 'Sourced',
  accepted: 'Accepted',
  rejected: 'Rejected',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  not_interested: 'Not interested',
  meeting_booked: 'Meeting booked',
  interviewed: 'Interviewed',
  shortlisted: 'Shortlisted',
  hired: 'Hired',
  unsubscribed: 'Unsubscribed',
};

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}
