// Wipes ALL app data: the Mongo database from MONGO_URL and the BullMQ queue keys in Redis.
// Stop the API and the worker first, then run:  npm run reset:db -- --yes
import mongoose from 'mongoose';
import IORedis from 'ioredis';
import { config } from '../src/config';

async function main() {
  if (!process.argv.includes('--yes')) {
    console.log(`This deletes everything in ${config.mongoUrl} and all "bull:*" keys in ${config.redisUrl}.\nRe-run with --yes to confirm.`);
    process.exit(1);
  }

  await mongoose.connect(config.mongoUrl, { serverSelectionTimeoutMS: 10_000 });
  const name = mongoose.connection.name;
  await mongoose.connection.dropDatabase();
  console.log(`Dropped Mongo database "${name}"`);
  await mongoose.disconnect();

  const redis = new IORedis(config.redisUrl);
  let removed = 0;
  const stream = redis.scanStream({ match: 'bull:*', count: 200 });
  for await (const keys of stream as AsyncIterable<string[]>) {
    if (keys.length) removed += await redis.del(...keys);
  }
  console.log(`Removed ${removed} queue keys from Redis`);
  redis.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
