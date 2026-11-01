import { Router } from 'express';
import { actionsRouter } from './actions.routes';
import { bookingRouter } from './booking.routes';
import { campaignsRouter } from './campaigns.routes';
import { candidatesRouter } from './candidates.routes';
import { conversationsRouter } from './conversations.routes';
import { eventsRouter } from './events.routes';
import { jobsRouter } from './jobs.routes';
import { outreachRouter } from './outreach.routes';
import { repliesRouter } from './replies.routes';

export { simulateReply } from './replies.routes';

export const router = Router();

router.use(eventsRouter);
router.use(conversationsRouter);
router.use(actionsRouter);
router.use(jobsRouter);
router.use(candidatesRouter);
router.use(campaignsRouter);
router.use(outreachRouter);
router.use(repliesRouter);
router.use(bookingRouter);
