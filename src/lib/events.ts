import { redis } from '../redis';
import { log } from '../logger';

export type AppEvent =
  | { type: 'message'; conversationId: string; message: unknown }
  | { type: 'agent'; conversationId: string; status: string | null }
  | { type: 'refresh'; entity: string; jobId?: string; id?: string };

export const EVENTS_CHANNEL = 'recruiter:events';

export function emit(event: AppEvent) {
  redis.publish(EVENTS_CHANNEL, JSON.stringify(event)).catch((err) => log.warn({ err }, 'event publish failed'));
}

export function refresh(entity: string, ids: { jobId?: unknown; id?: unknown } = {}) {
  emit({
    type: 'refresh',
    entity,
    jobId: ids.jobId ? String(ids.jobId) : undefined,
    id: ids.id ? String(ids.id) : undefined,
  });
}
