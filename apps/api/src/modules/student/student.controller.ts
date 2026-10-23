import { Request, Response } from 'express';
import { z } from 'zod';
import { Errors } from '../../lib/errors';
import { uuidParam } from '../../lib/http';
import * as studentService from './student.service';

const startAttemptSchema = z.object({
  accessCode: z.string().trim().optional(),
});

const saveAnswerSchema = z.object({
  questionVersionId: z.string().uuid(),
  selectedPositions: z.array(z.number().int()).default([]),
  flagged: z.boolean().optional(),
  clientSeq: z.number().int().optional(),
});

const submitAttemptSchema = z.object({
  endedReason: z.enum(['STUDENT_SUBMIT', 'AUTO_SUBMIT']).optional(),
});

export const getDashboard = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();

  const data = await studentService.getStudentDashboard(userId);
  res.json({ data });
};

export const getSitting = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();
  const sittingId = uuidParam(req);

  const data = await studentService.getSittingDetails(userId, sittingId);
  res.json({ data });
};

export const startSitting = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();
  const sittingId = uuidParam(req);

  const body = startAttemptSchema.parse(req.body || {});
  const data = await studentService.startSittingAttempt(
    userId,
    sittingId,
    body.accessCode,
    req.ip,
    req.auth?.sessionId,
  );
  res.json({ data });
};

export const getAttempt = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();
  const attemptId = uuidParam(req);

  const data = await studentService.getAttemptPaper(userId, attemptId);
  res.json({ data });
};

export const saveAnswer = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();
  const attemptId = uuidParam(req);

  const body = saveAnswerSchema.parse(req.body);
  const data = await studentService.saveAnswer(userId, attemptId, body);
  res.json({ data });
};

export const heartbeat = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();
  const attemptId = uuidParam(req);

  const data = await studentService.recordHeartbeat(userId, attemptId, req.body || {});
  res.json({ data });
};

export const recordEvent = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();
  const attemptId = uuidParam(req);

  const data = await studentService.recordAttemptEvent(userId, attemptId, req.body || {});
  res.json({ data });
};

export const submitAttempt = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();
  const attemptId = uuidParam(req);

  const body = submitAttemptSchema.parse(req.body || {});
  const data = await studentService.submitAttempt(userId, attemptId, body);
  res.json({ data });
};

export const getResults = async (req: Request, res: Response) => {
  const userId = req.auth?.userId;
  if (!userId) throw Errors.tokenExpired();

  const data = await studentService.getStudentResults(userId);
  res.json({ data });
};
