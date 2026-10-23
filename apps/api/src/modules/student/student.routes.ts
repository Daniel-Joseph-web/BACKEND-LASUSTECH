import express from 'express';
import { requireAuth, requireRole } from '../auth/auth.middleware';
import * as controller from './student.controller';
import { candidateExamRateLimiter } from '../../lib/rate-limiter';

export const studentRouter = express.Router();

studentRouter.use(requireAuth, requireRole('STUDENT'));

studentRouter.get('/dashboard', controller.getDashboard);
studentRouter.get('/results', controller.getResults);
studentRouter.get('/sittings/:id', controller.getSitting);
studentRouter.post('/sittings/:id/start', candidateExamRateLimiter, controller.startSitting);
studentRouter.get('/attempts/:id', controller.getAttempt);
studentRouter.post('/attempts/:id/heartbeat', candidateExamRateLimiter, controller.heartbeat);
studentRouter.post('/attempts/:id/events', candidateExamRateLimiter, controller.recordEvent);
studentRouter.post('/attempts/:id/answer', candidateExamRateLimiter, controller.saveAnswer);
studentRouter.post('/attempts/:id/answers', candidateExamRateLimiter, controller.saveAnswer);
studentRouter.post('/attempts/:id/submit', candidateExamRateLimiter, controller.submitAttempt);
