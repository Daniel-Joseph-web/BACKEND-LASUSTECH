import { Router } from 'express';
import {
  getPublicAttempt,
  getPublicExam,
  recordPublicEvent,
  recordPublicFlag,
  recordPublicHeartbeat,
  savePublicAnswer,
  startPublicAttempt,
  submitPublicAttempt,
} from './public-exams.controller';

/**
 * Mounted at /api/v1/public in main.ts, before any requireAuth router.
 * Candidates are anonymous; the attempt endpoints authenticate with the
 * scoped attempt token issued by POST /exams/:slug/start.
 */
export const publicExamRouter = Router();

publicExamRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

publicExamRouter.get('/exams/:slug', getPublicExam);
publicExamRouter.post('/exams/:slug/start', startPublicAttempt);

publicExamRouter.get('/attempts/:id', getPublicAttempt);
publicExamRouter.put('/attempts/:id/answers', savePublicAnswer);
publicExamRouter.post('/attempts/:id/answers', savePublicAnswer);
publicExamRouter.post('/attempts/:id/heartbeat', recordPublicHeartbeat);
publicExamRouter.post('/attempts/:id/events', recordPublicEvent);
publicExamRouter.post('/attempts/:id/flag', recordPublicFlag);
publicExamRouter.post('/attempts/:id/submit', submitPublicAttempt);
