import { Queue } from 'bullmq';
import { bullConnection } from '../redis';

export const QUEUES = {
  sourcing: 'sourcing',
  scoring: 'scoring',
  drafting: 'drafting',
  sending: 'sending',
  replies: 'replies',
} as const;

const retry = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 3000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

const make = (name: string) => new Queue(name, { connection: bullConnection, defaultJobOptions: retry });

export const sourcingQueue = make(QUEUES.sourcing);
export const scoringQueue = make(QUEUES.scoring);
export const draftingQueue = make(QUEUES.drafting);
export const replyQueue = make(QUEUES.replies);

export const sendingQueue = new Queue(QUEUES.sending, {
  connection: bullConnection,
  defaultJobOptions: { ...retry, removeOnComplete: true, removeOnFail: { count: 500 } },
});

export function isLastAttempt(job: { attemptsMade: number; opts: { attempts?: number } }) {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

export const closeQueues = () =>
  Promise.allSettled([sourcingQueue, scoringQueue, draftingQueue, replyQueue, sendingQueue].map((q) => q.close()));
