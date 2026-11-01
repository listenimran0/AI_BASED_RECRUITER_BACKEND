import IORedis from 'ioredis';
import { config } from './config';

const u = new URL(config.redisUrl);

// bullmq wants plain options so it can open its own blocking connections
export const bullConnection = {
  host: u.hostname,
  port: Number(u.port || 6379),
  username: u.username || undefined,
  password: u.password || undefined,
  maxRetriesPerRequest: null as null,
};

export const redis = new IORedis(config.redisUrl);

export function newRedis() {
  return new IORedis(config.redisUrl);
}
