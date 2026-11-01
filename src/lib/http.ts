import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { log } from '../logger';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HttpError(400, msg);
  }
  return result.data;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) return res.status(400).json({ error: err.message });
  if (err instanceof Error && err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  log.error({ err }, 'unhandled request error');
  res.status(500).json({ error: 'Something went wrong on the server' });
}
