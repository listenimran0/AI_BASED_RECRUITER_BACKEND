import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../lib/http';
import { bookSlot, getBooking } from '../services/booking';

export const bookingRouter = Router();

bookingRouter.get('/public/booking/:token', async (req, res) => {
  res.json(await getBooking(req.params.token));
});

bookingRouter.post('/public/booking/:token', async (req, res) => {
  const { slot } = parse(z.object({ slot: z.string() }), req.body);
  res.status(201).json(await bookSlot(req.params.token, slot));
});
