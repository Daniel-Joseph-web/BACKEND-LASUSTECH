import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { pageMeta, pageShape, uuidParam } from '../../lib/http';
import { notifyUsers } from '../../lib/notify';

const appealInclude = {
  student: { select: { id: true, names: true, matricNo: true } },
  assignee: { select: { id: true, names: true } },
  result: {
    select: {
      id: true,
      rawScore: true,
      maxScore: true,
      percent: true,
      grade: true,
      status: true,
      attempt: {
        select: {
          id: true,
          sitting: {
            select: {
              id: true,
              exam: {
                select: {
                  id: true,
                  title: true,
                  course: { select: { id: true, code: true, title: true } },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.AppealInclude;

type AppealRow = Prisma.AppealGetPayload<{ include: typeof appealInclude }>;

const present = (a: AppealRow) => {
  const exam = a.result.attempt.sitting?.exam;
  return {
    id: a.id,
    studentId: a.student.id,
    studentName: a.student.names,
    matricNo: a.student.matricNo,
    courseCode: exam?.course?.code ?? null,
    courseTitle: exam?.course?.title ?? null,
    examTitle: exam?.title ?? null,
    sittingId: a.result.attempt.sitting?.id ?? null,
    attemptId: a.result.attempt.id,
    reason: a.reason,
    status: a.status,
    outcome: a.outcome,
    resolutionNote: a.resolutionNote,
    assigneeId: a.assigneeId,
    assigneeName: a.assignee?.names ?? null,
    createdAt: a.createdAt,
    resultId: a.result.id,
    rawScore: Number(a.result.rawScore),
    maxScore: Number(a.result.maxScore),
    percent: Number(a.result.percent),
    grade: a.result.grade,
    resultStatus: a.result.status,
  };
};

const listQuery = z.object({
  ...pageShape,
  status: z.enum(['ALL', 'OPEN', 'NEW', 'UNDER_REVIEW', 'RESOLVED']).default('ALL'),
  search: z.string().trim().max(120).optional(),
});

export const listAppeals = async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.AppealWhereInput = {};

  if (q.status === 'OPEN') where.status = { in: ['NEW', 'UNDER_REVIEW'] };
  else if (q.status !== 'ALL') where.status = q.status;

  if (q.search) {
    const search = q.search;
    where.OR = [
      { student: { names: { contains: search, mode: 'insensitive' } } },
      { student: { matricNo: { contains: search, mode: 'insensitive' } } },
      { reason: { contains: search, mode: 'insensitive' } },
      { result: { attempt: { sitting: { exam: { title: { contains: search, mode: 'insensitive' } } } } } },
      { result: { attempt: { sitting: { exam: { course: { code: { contains: search, mode: 'insensitive' } } } } } } },
    ];
  }

  const [rows, total, open, underReview, resolved] = await Promise.all([
    prisma.appeal.findMany({
      where,
      include: appealInclude,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.appeal.count({ where }),
    prisma.appeal.count({ where: { status: { in: ['NEW', 'UNDER_REVIEW'] } } }),
    prisma.appeal.count({ where: { status: 'UNDER_REVIEW' } }),
    prisma.appeal.count({ where: { status: 'RESOLVED' } }),
  ]);

  res.json({
    data: rows.map(present),
    meta: { ...pageMeta(q.page, q.pageSize, total), counts: { open, underReview, resolved } },
  });
};

const findAppeal = async (id: string) => {
  const appeal = await prisma.appeal.findUnique({ where: { id }, include: appealInclude });
  if (!appeal) throw Errors.notFound('Appeal');
  return appeal;
};

export const getAppeal = async (req: Request, res: Response) => {
  const appeal = await findAppeal(uuidParam(req));
  res.json({ data: present(appeal) });
};

/** Claims an appeal for the signed-in administrator and moves it to UNDER_REVIEW. */
export const reviewAppeal = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const actor = actorFrom(req, res);

  const updated = await prisma.$transaction(async (tx) => {
    const appeal = await tx.appeal.findUnique({ where: { id } });
    if (!appeal) throw Errors.notFound('Appeal');
    if (appeal.status === 'RESOLVED') {
      throw Errors.conflict('APPEAL_RESOLVED', 'This appeal has already been resolved.');
    }

    const after = await tx.appeal.update({
      where: { id },
      data: {
        status: 'UNDER_REVIEW',
        assigneeId: actor.actorId,
      },
      include: appealInclude,
    });
    await writeAudit(tx, actor, {
      action: 'appeal.review',
      targetType: 'Appeal',
      targetId: id,
      before: { status: appeal.status, assigneeId: appeal.assigneeId },
      after: { status: after.status, assigneeId: after.assigneeId },
    });
    return after;
  });

  res.json({ data: present(updated) });
};

const resolveSchema = z
  .object({
    outcome: z.enum(['KEEP', 'CHANGE_SCORE', 'FIX_KEY']),
    resolutionNote: z.string().trim().min(3).max(2000),
    newScore: z.number().min(0).optional(),
  })
  .refine((v) => v.outcome !== 'CHANGE_SCORE' || v.newScore !== undefined, {
    message: 'Enter the corrected raw score.',
    path: ['newScore'],
  });

const GRADE_FALLBACK: { grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'; min: number }[] = [
  { grade: 'A', min: 70 },
  { grade: 'B', min: 60 },
  { grade: 'C', min: 50 },
  { grade: 'D', min: 45 },
  { grade: 'E', min: 40 },
  { grade: 'F', min: 0 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export const resolveAppeal = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = resolveSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const updated = await prisma.$transaction(async (tx) => {
    const appeal = await tx.appeal.findUnique({
      where: { id },
      include: {
        result: {
          select: {
            id: true,
            attemptId: true,
            scoreVersion: true,
            rawScore: true,
            maxScore: true,
            percent: true,
            grade: true,
            isCurrent: true,
          },
        },
      },
    });
    if (!appeal) throw Errors.notFound('Appeal');
    if (appeal.status === 'RESOLVED') {
      throw Errors.conflict('APPEAL_RESOLVED', 'This appeal has already been resolved.');
    }

    if (body.outcome === 'CHANGE_SCORE') {
      const newScore = body.newScore as number;
      const maxScore = Number(appeal.result.maxScore);
      if (newScore > maxScore) {
        throw Errors.badRequest(
          'SCORE_TOO_HIGH',
          `The corrected score cannot exceed the paper maximum (${maxScore}).`,
        );
      }

      const percent = maxScore > 0 ? round2((newScore / maxScore) * 100) : 0;
      const bands = await tx.gradeBand.findMany({ orderBy: { minPercent: 'desc' } });
      const grade =
        bands.find((b) => percent >= Number(b.minPercent))?.grade ??
        GRADE_FALLBACK.find((b) => percent >= b.min)!.grade;

      const oldScore = Number(appeal.result.rawScore);

      if (oldScore !== newScore) {
        // Supersede the current result rather than editing a scored row: the
        // partial unique index on (attempt_id) WHERE is_current keeps one live
        // result per attempt, and the old version stays as evidence.
        await tx.result.update({ where: { id: appeal.result.id }, data: { isCurrent: false } });
        await tx.result.create({
          data: {
            attemptId: appeal.result.attemptId,
            scoreVersion: appeal.result.scoreVersion + 1,
            rawScore: new Prisma.Decimal(newScore),
            maxScore: appeal.result.maxScore,
            percent: new Prisma.Decimal(percent),
            grade,
            status: 'AMENDED',
            isCurrent: true,
          },
        });
        await tx.scoreChange.create({
          data: {
            resultId: appeal.result.id,
            appealId: appeal.id,
            oldScore: appeal.result.rawScore,
            newScore: new Prisma.Decimal(newScore),
            reason: body.resolutionNote,
            createdBy: actor.actorId,
            approvedBy: actor.actorId,
          },
        });
        // A released batch must be re-approved before it goes back out.
        await tx.resultBatch.updateMany({
          where: {
            sitting: { attempts: { some: { id: appeal.result.attemptId } } },
            status: { in: ['APPROVED', 'RELEASED'] },
          },
          data: { status: 'PENDING', releasedAt: null, releasedBy: null },
        });
      }
    }

    const after = await tx.appeal.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        outcome: body.outcome,
        resolutionNote: body.resolutionNote,
        assigneeId: appeal.assigneeId ?? actor.actorId,
      },
      include: appealInclude,
    });

    await writeAudit(tx, actor, {
      action: 'appeal.resolve',
      targetType: 'Appeal',
      targetId: id,
      before: { status: appeal.status, outcome: appeal.outcome },
      after: {
        status: after.status,
        outcome: after.outcome,
        resolutionNote: after.resolutionNote,
        newScore: body.newScore ?? null,
      },
    });

    const course = after.result.attempt.sitting?.exam?.course;
    await notifyUsers(tx, [appeal.studentId], {
      type: 'SYSTEM',
      title: 'Appeal resolved',
      body: `${course ? `${course.code} appeal` : 'Your appeal'} — ${after.resolutionNote}`,
      meta: { appealId: id, outcome: body.outcome, href: '/student/results' },
    });

    return after;
  });

  res.json({ data: present(updated) });
};
