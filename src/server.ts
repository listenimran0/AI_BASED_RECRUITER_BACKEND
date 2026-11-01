import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import { config } from './config';
import { connectDb } from './db';
import { errorHandler } from './lib/http';
import { log } from './logger';
import { redis } from './redis';
import { router, simulateReply } from './routes';

async function main() {
  await connectDb();

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  app.use(cors({ origin: config.frontendUrl
    .split(',')
    .map(url => url.trim())
  }));

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', router);
  app.post('/simulate-reply', simulateReply);
  app.use(errorHandler);

  const server = app.listen(config.port, () => log.info(`api listening on :${config.port}`));

  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down api');
    server.close(async () => {
      await Promise.allSettled([redis.quit(), mongoose.disconnect()]);
      process.exit(0);
    });
    // open event streams keep the server alive, so force the exit after a grace period
    setTimeout(() => process.exit(0), 5000).unref();
    server.closeAllConnections();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'api failed to start');
  process.exit(1);
});
