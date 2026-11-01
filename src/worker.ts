
import mongoose from 'mongoose';
import { Worker } from 'bullmq';

import { connectDb } from './db';
import { log } from './logger';
import { QUEUES, closeQueues } from './queues';
import { bullConnection, redis } from './redis';
import { config } from './config';

import { enqueueDueMessages } from './services/campaigns';

import { processDrafting } from './workers/drafting';
import { processReply } from './workers/replies';
import { processScoring } from './workers/scoring';
import { processSend } from './workers/sender';
import { processSourcing } from './workers/sourcing';

async function main() {
  await connectDb();

  const workers = [
    new Worker(QUEUES.sourcing, processSourcing, {
      connection: bullConnection,
      concurrency: 2,
    }),

    new Worker(QUEUES.scoring, processScoring, {
      connection: bullConnection,
      concurrency: config.concurrency.scoring,
    }),

    new Worker(QUEUES.drafting, processDrafting, {
      connection: bullConnection,
      concurrency: config.concurrency.drafting,
    }),

    new Worker(QUEUES.replies, processReply, {
      connection: bullConnection,
      concurrency: 3,
    }),

    new Worker(QUEUES.sending, processSend, {
      connection: bullConnection,
      concurrency: 1,
    }),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => {
      log.warn(
        {
          queue: w.name,
          job: job?.id,
          err: err.message,
        },
        'job failed'
      );
    });

    w.on('error', (err) => {
      log.error(
        {
          queue: w.name,
          err,
        },
        'worker error'
      );
    });
  }

  let shuttingDown = false;
  let sweepPromise: Promise<void> | null = null;

  const runSweep = (): Promise<void> | undefined => {
    if (sweepPromise || shuttingDown) return;

    sweepPromise = (async () => {
      try {
        await enqueueDueMessages();
      } catch (err) {
        log.warn({ err }, 'sweep failed');
      } finally {
        sweepPromise = null;
      }
    })();

    return sweepPromise;
  };

  void runSweep();

  const sweepTimer = setInterval(() => {
    void runSweep();
  }, config.outreach.sweepEveryMs);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;

    shuttingDown = true;

    log.info({ signal }, 'shutting down workers');

    clearInterval(sweepTimer);

    if (sweepPromise) {
      await sweepPromise;
    }

    const workerResults = await Promise.allSettled([
      ...workers.map((worker) => worker.close()),
      closeQueues(),
    ]);

    const connectionResults = await Promise.allSettled([
      redis.quit(),
      mongoose.disconnect(),
    ]);

    const results = [...workerResults, ...connectionResults];

    const failures = results.filter(
      (result) => result.status === 'rejected'
    );

    if (failures.length > 0) {
      log.error(
        { failures },
        'some resources failed to close'
      );

      process.exitCode = 1;
    } else {
      log.info('all workers and connections closed');
      process.exitCode = 0;
    }

    process.exit();
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  log.info('workers running');
}

main().catch((err) => {
  log.error({ err }, 'worker failed to start');
  process.exit(1);
});
