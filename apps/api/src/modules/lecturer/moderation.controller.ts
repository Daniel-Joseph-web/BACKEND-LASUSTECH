import { Request, Response } from 'express';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { uuidParam, pageMeta, pageShape } from '../../lib/http';
import { z } from 'zod';

const reviewSchema = z
  .object({
    decision: z.enum(['APPROVED', 'RETURNED']),
    comment: z.string().max(1000).optional(),
  })
  .refine((d) => d.decision !== 'RETURNED' || !!d.comment?.trim(), {
    message: 'A feedback comment is required when returning a submission.',
    path: ['comment'],
  });

const listQuery = z.object({
  ...pageShape,
  filter: z.enum(['needs_review', 'my_submissions']).default('needs_review'),
});

// --- 1. Moderation queues ---
export const getQuestionSubmissions = async (req: Request, res: Response) => {
  const actor = actorFrom(req, res);
  const q = listQuery.parse(req.query);
  const mine = q.filter === 'my_submissions';

  const where: Prisma.QuestionVersionWhereInput = mine
    ? {
        // Everything I authored that has left DRAFT
        authorId: actor.actorId,
        status: { in: ['PENDING', 'RETURNED', 'APPROVED'] },
      }
    : {
        // Pending items from OTHER lecturers, in courses I'm assigned to
        status: 'PENDING',
        authorId: { not: actor.actorId },
        question: { course: { assignments: { some: { userId: actor.actorId } } } },
      };

  const [total, versions] = await Promise.all([
    prisma.questionVersion.count({ where }),
    prisma.questionVersion.findMany({
      where,
      include: {
        question: { select: { course: { select: { code: true } }, answerFormat: true } },
        author: { select: { names: true } },
        topic: { select: { name: true } },
        options: { orderBy: { position: 'asc' } },
      },
      orderBy: [{ question: { createdAt: 'desc' } }, { versionNo: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);

  // Latest moderator feedback for each version (shown on "My submissions")
  const reviews = versions.length
    ? await prisma.moderationReview.findMany({
        where: { targetType: 'QUESTION_VERSION', targetId: { in: versions.map((v) => v.id) } },
        include: { reviewer: { select: { names: true } } },
      })
    : [];
  const reviewByVersion = new Map<string, (typeof reviews)[number]>();
  for (const r of reviews) reviewByVersion.set(r.targetId, r);

  res.json({
    data: versions.map((v) => {
      const review = reviewByVersion.get(v.id);
      return {
        id: v.id,
        questionId: v.questionId,
        courseCode: v.question.course.code,
        answerFormat: v.question.answerFormat,
        versionNo: v.versionNo,
        status: v.status,
        stem: v.stem,
        hasMath: v.hasMath,
        options: v.options,
        difficulty: v.difficulty,
        marks: Number(v.marks),
        authorName: v.author.names,
        topicName: v.topic.name,
        explanation: v.explanation,
        // Only show feedback while it still applies
        reviewComment: v.status === 'RETURNED' || v.status === 'APPROVED' ? (review?.comment ?? null) : null,
        reviewerName: v.status === 'RETURNED' || v.status === 'APPROVED' ? (review?.reviewer.names ?? null) : null,
      };
    }),
    meta: pageMeta(q.page, q.pageSize, total),
  });
};

// --- 2. Moderation decision (atomic) ---
export const reviewQuestionVersion = async (req: Request, res: Response) => {
  const versionId = uuidParam(req);
  const body = reviewSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const target = await prisma.questionVersion.findUnique({
    where: { id: versionId },
    select: { id: true, status: true, authorId: true, question: { select: { courseId: true } } },
  });

  if (!target) throw Errors.notFound('Question Version');
  if (target.status !== 'PENDING') {
    throw Errors.conflict('INVALID_STATE', 'Only PENDING submissions can be reviewed.');
  }

  // Separation of duties
  if (target.authorId === actor.actorId) throw Errors.forbidden();

  // Reviewer must be assigned to the course
  const assigned = await prisma.courseAssignment.findFirst({
    where: { courseId: target.question.courseId, userId: actor.actorId },
    select: { userId: true },
  });
  if (!assigned) throw Errors.forbidden();

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.questionVersion.update({
      where: { id: versionId },
      data: {
        status: body.decision,
        ...(body.decision === 'APPROVED' && { approvedBy: actor.actorId, approvedAt: new Date() }),
      },
    });

    await tx.moderationReview.create({
      data: {
        targetType: 'QUESTION_VERSION',
        targetId: versionId,
        reviewerId: actor.actorId,
        decision: body.decision,
        comment: body.comment?.trim() || undefined,
      },
    });

    await writeAudit(tx, actor, {
      action: 'moderation.review_question',
      targetType: 'QuestionVersion',
      targetId: versionId,
      before: { status: 'PENDING' },
      after: { status: body.decision, comment: body.comment },
    });

    return updated;
  });

  res.json({
    data: { id: result.id, status: result.status },
    message: `Submission ${body.decision.toLowerCase()} successfully.`,
  });
};