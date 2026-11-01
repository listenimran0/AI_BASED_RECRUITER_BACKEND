import { EventEmitter } from 'node:events';
import { Router } from 'express';
import { EVENTS_CHANNEL } from '../lib/events';
import { newRedis } from '../redis';

export const eventsRouter = Router();

const bus = new EventEmitter();
bus.setMaxListeners(0);
const subscriber = newRedis();
subscriber.subscribe(EVENTS_CHANNEL);
subscriber.on('message', (_channel, raw) => bus.emit('event', raw));

eventsRouter.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const send = (raw: string) => res.write(`data: ${raw}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  bus.on('event', send);
  req.on('close', () => {
    clearInterval(ping);
    bus.off('event', send);
  });
});
