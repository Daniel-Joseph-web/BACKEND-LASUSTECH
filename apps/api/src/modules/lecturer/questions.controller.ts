import { Request, Response } from 'express';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit, Tx } from '../../lib/audit';
import { pageMeta, pageShape, uuidParam } from '../../lib/http';
import { mediaView, mediaUrl } from '../../lib/media';
import { createQuestionSchema, updateQuestionSchema } from './questions.schema';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Scope = { courseId?: string; subjectId?: string };

/** Questions the caller may see: assigned course, or a subject they created. */
export const ownedQuestionWhere = (userId: string): Prisma.QuestionWhereInput => ({
  OR: [
    { course: { assignments: { some: { userId } } } },
    { subject: { createdBy: userId } },
  ],
});

/** Asserts the caller is assigned to the course or owns the subject. */
export async function assertScopeAccess(
  db: Tx,
  userId: string,
  scope: Scope,
) {
  if (scope.courseId) {
    const assignment = await db.courseAssignment.findFirst({
      where: { courseId: scope.courseId, userId },
      // CourseAssignment has a composite key (course/user/session/role), so
      // there is no `id` to select.
      select: { courseId: true },
    });
    if (!assignment) throw Errors.forbidden();
    return;
  }
  if (scope.subjectId) {
    const subject = await db.subject.findFirst({
      where: { id: scope.subjectId, createdBy: userId },
      select: { id: true },
    });
    if (!subject) throw Errors.forbidden();
    return;
  }
  throw Errors.badRequest('MISSING_SCOPE', 'Choose a course or a subject.');
}

export function scopeWhere(scope: Scope): Prisma.QuestionWhereInput {
  return scope.courseId ? { courseId: scope.courseId } : { subjectId: scope.subjectId };
}

export function scopeLabel(scope: Scope) {
  return scope.courseId ? { courseId: scope.courseId } : { subjectId: scope.subjectId };
}

/** Returns a real topic id for the owner. Falls back to (and creates) "General". */
async function resolveTopicId(tx: Tx, scope: Scope, topicId?: string): Promise<string> {
  if (topicId && UUID_RE.test(topicId)) {
    const found = await tx.topic.findFirst({
      where: {
        id: topicId,
        ...(scope.courseId ? { courseId: scope.courseId } : { subjectId: scope.subjectId }),
      },
      select: { id: true },
    });
    if (found) return found.id;
  }

  if (scope.courseId) {
    const general = await tx.topic.upsert({
      where: { courseId_name: { courseId: scope.courseId, name: 'General' } },
      update: {},
      create: { courseId: scope.courseId, name: 'General' },
    });
    return general.id;
  }

  const general = await tx.topic.upsert({
    where: { subjectId_name: { subjectId: scope.subjectId!, name: 'General' } },
    update: {},
    create: { subjectId: scope.subjectId!, name: 'General' },
  });
  return general.id;
}

const versionInclude = {
  topic: { select: { id: true, name: true } },
  stemMedia: true,
  options: { orderBy: { position: 'asc' as const }, include: { media: true } },
} satisfies Prisma.QuestionVersionInclude;

type VersionWithMedia = Prisma.QuestionVersionGetPayload<{ include: typeof versionInclude }>;

const presentVersion = (version: VersionWithMedia) => ({
  ...version,
  stemMediaUrl: version.stemMedia ? mediaUrl(version.stemMedia.id) : null,
  stemMedia: mediaView(version.stemMedia),
  options: version.options.map((option) => ({
    ...option,
    mediaUrl: option.media ? mediaUrl(option.media.id) : null,
    media: mediaView(option.media),
  })),
});

// --- List & Filter Questions ---
const listQuery = z.object({
  ...pageShape,
  courseId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  search: z.string().trim().optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  status: z
    .enum(['DRAFT', 'PENDING', 'RETURNED', 'APPROVED', 'LOCKED', 'RETIRED'])
    .optional(),
});

export const listQuestions = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const q = listQuery.parse(req.query);

  const where: Prisma.QuestionWhereInput = {
    AND: [
      ownedQuestionWhere(userId),
      ...(q.courseId ? [{ courseId: q.courseId }] : []),
      ...(q.subjectId ? [{ subjectId: q.subjectId }] : []),
    ],
  };

  // `stem` and `explanation` live on QuestionVersion, not Question, so the
  // search filter belongs here rather than in the QuestionWhereInput above.
  const versionWhere: Prisma.QuestionVersionWhereInput = {
    ...(q.difficulty && { difficulty: q.difficulty }),
    ...(q.status && { status: q.status }),
    ...(q.search
      ? {
          OR: [
            {
              stem: {
                path: ['text'],
                string_contains: q.search,
                mode: 'insensitive',
              },
            },
            { explanation: { contains: q.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, questions] = await Promise.all([
    prisma.question.count({ where: { ...where, versions: { some: versionWhere } } }),
    prisma.question.findMany({
      where: { ...where, versions: { some: versionWhere } },
      include: {
        course: { select: { id: true, code: true, title: true } },
        subject: { select: { id: true, name: true, level: true, institution: true } },
        versions: {
          where: { versionNo: { gte: 1 } },
          orderBy: { versionNo: 'desc' },
          take: 1,
          include: versionInclude,
        },
      },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  res.json({
    data: questions.map((item) => ({
      id: item.id,
      courseId: item.courseId,
      subjectId: item.subjectId,
      courseCode: item.course?.code ?? null,
      course: item.course,
      subject: item.subject,
      ownerLabel: item.course
        ? `${item.course.code} — ${item.course.title}`
        : `${item.subject?.name ?? 'Subject'}${item.subject?.level ? ` (${item.subject.level})` : ''}`,
      answerFormat: item.answerFormat,
      version: item.versions[0] ? presentVersion(item.versions[0]) : null,
    })),
    meta: pageMeta(q.page, q.pageSize, total),
  });
};

// --- Create New Question ---
export const createQuestion = async (req: Request, res: Response) => {
  const body = createQuestionSchema.parse(req.body);
  const actor = actorFrom(req, res);
  const scope: Scope = body.courseId
    ? { courseId: body.courseId }
    : { subjectId: body.subjectId };

  await assertScopeAccess(prisma, actor.actorId, scope);

  const isApproved = body.status === 'APPROVED';

  const created = await prisma.$transaction(async (tx) => {
    const topicId = await resolveTopicId(tx, scope, body.topicId);

    const question = await tx.question.create({
      data: {
        courseId: body.courseId,
        subjectId: body.subjectId,
        answerFormat: body.answerFormat,
        createdBy: actor.actorId,
      },
    });

    const version = await tx.questionVersion.create({
      data: {
        questionId: question.id,
        versionNo: 1,
        stem: body.stem as Prisma.InputJsonValue,
        stemMediaId: body.stemMediaId ?? null,
        explanation: body.explanation,
        hasMath: body.hasMath,
        topicId,
        difficulty: body.difficulty,
        marks: body.marks,
        status: body.status,
        answerSource: 'LECTURER',
        authorId: actor.actorId,
        approvedBy: isApproved ? actor.actorId : null,
        approvedAt: isApproved ? new Date() : null,
        options: {
          create: body.options.map((o) => ({
            position: o.position,
            body: o.body as Prisma.InputJsonValue,
            mediaId: o.mediaId ?? null,
            isCorrect: o.isCorrect,
          })),
        },
      },
      include: versionInclude,
    });

    await tx.question.update({
      where: { id: question.id },
      data: { currentVersionId: version.id },
    });

    await writeAudit(tx, actor, {
      action: 'question.create',
      targetType: 'Question',
      targetId: question.id,
      after: { versionId: version.id, status: body.status },
    });

    return { question, version };
  });

  res.status(201).json({
    data: { ...created.question, version: presentVersion(created.version) },
  });
};

export const getQuestionById = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const userId = req.auth!.userId;

  const question = await prisma.question.findFirst({
    where: { id, ...ownedQuestionWhere(userId) },
    include: {
      course: { select: { id: true, code: true, title: true } },
      subject: { select: { id: true, name: true, level: true, institution: true } },
      versions: {
        orderBy: { versionNo: 'desc' },
        take: 1,
        include: versionInclude,
      },
    },
  });

  if (!question || question.versions.length === 0) {
    throw Errors.notFound('Question');
  }

  res.json({
    data: {
      id: question.id,
      courseId: question.courseId,
      subjectId: question.subjectId,
      course: question.course,
      subject: question.subject,
      answerFormat: question.answerFormat,
      version: presentVersion(question.versions[0]),
    },
  });
};

// --- Edit/Update Question (immutable versioning for approved) ---
export const updateQuestion = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = updateQuestionSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const existing = await prisma.question.findUnique({
    where: { id },
    include: {
      versions: { orderBy: { versionNo: 'desc' }, take: 1, include: { options: true } },
    },
  });

  if (!existing || existing.versions.length === 0) throw Errors.notFound('Question');
  if (body.courseId && body.subjectId) {
    throw Errors.badRequest('AMBIGUOUS_SCOPE', 'A question belongs to either a course or a subject.');
  }

  const existingScope: Scope = existing.courseId
    ? { courseId: existing.courseId }
    : { subjectId: existing.subjectId ?? undefined };
  await assertScopeAccess(prisma, actor.actorId, existingScope);

  const nextScope: Scope = body.courseId
    ? { courseId: body.courseId }
    : body.subjectId
      ? { subjectId: body.subjectId }
      : existingScope;
  if (body.courseId || body.subjectId) {
    await assertScopeAccess(prisma, actor.actorId, nextScope);
  }

  const latestVersion = existing.versions[0];

  if (['LOCKED', 'RETIRED'].includes(latestVersion.status)) {
    throw Errors.conflict('LOCKED', 'This question is locked and cannot be edited.');
  }
  if (latestVersion.status === 'PENDING') {
    throw Errors.conflict('PENDING_REVIEW', 'This question is awaiting moderation and cannot be edited.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    let targetVersionId = latestVersion.id;

    const topicId =
      body.topicId !== undefined ? await resolveTopicId(tx, nextScope, body.topicId) : undefined;

    const nextStatus = body.status ?? (latestVersion.status === 'APPROVED' ? 'APPROVED' : 'DRAFT');
    const isApproved = nextStatus === 'APPROVED';

    // Quick status toggle (Draft <-> Approved) without duplicating version
    if (
      body.status &&
      body.stem === undefined &&
      body.options === undefined &&
      body.difficulty === undefined &&
      body.marks === undefined &&
      body.explanation === undefined &&
      body.topicId === undefined
    ) {
      await tx.questionVersion.update({
        where: { id: latestVersion.id },
        data: {
          status: body.status,
          ...(isApproved
            ? { approvedBy: actor.actorId, approvedAt: new Date() }
            : body.status === 'DRAFT'
            ? { approvedBy: null, approvedAt: null }
            : {}),
        },
      });
      await writeAudit(tx, actor, {
        action: 'question.update_status',
        targetType: 'Question',
        targetId: id,
        before: { status: latestVersion.status },
        after: { status: body.status },
      });
      return tx.question.findUnique({
        where: { id },
        include: { versions: { where: { id: latestVersion.id }, include: versionInclude } },
      });
    }

    if (latestVersion.status === 'APPROVED') {
      const newVersion = await tx.questionVersion.create({
        data: {
          questionId: id,
          versionNo: latestVersion.versionNo + 1,
          stem: (body.stem ?? latestVersion.stem) as Prisma.InputJsonValue,
          stemMediaId:
            body.stemMediaId !== undefined ? body.stemMediaId : latestVersion.stemMediaId,
          explanation: body.explanation ?? latestVersion.explanation,
          hasMath: body.hasMath ?? latestVersion.hasMath,
          topicId: topicId ?? latestVersion.topicId,
          difficulty: body.difficulty ?? latestVersion.difficulty,
          marks: body.marks ?? latestVersion.marks,
          status: nextStatus,
          answerSource: 'LECTURER',
          authorId: actor.actorId,
          approvedBy: isApproved ? actor.actorId : null,
          approvedAt: isApproved ? new Date() : null,
          options: {
            create: (body.options || latestVersion.options).map((o) => ({
              position: o.position,
              body: o.body as Prisma.InputJsonValue,
              mediaId: (o as { mediaId?: string | null }).mediaId ?? null,
              isCorrect: o.isCorrect,
            })),
          },
        },
        include: versionInclude,
      });

      await tx.question.update({
        where: { id },
        data: {
          currentVersionId: newVersion.id,
          // A question belongs to exactly one owner; moving it to the other
          // kind of scope clears the previous one.
          ...(body.courseId !== undefined ? { courseId: body.courseId, subjectId: null } : {}),
          ...(body.subjectId !== undefined ? { subjectId: body.subjectId, courseId: null } : {}),
        },
      });
      targetVersionId = newVersion.id;

      await writeAudit(tx, actor, {
        action: 'question.update',
        targetType: 'Question',
        targetId: id,
        before: { versionNo: latestVersion.versionNo, status: latestVersion.status },
        after: { versionId: targetVersionId, updatedBy: actor.actorId },
      });

      return tx.question.findUnique({
        where: { id },
        include: { versions: { where: { id: targetVersionId }, include: versionInclude } },
      });
    }

    // DRAFT or RETURNED: safe to mutate in place
    await tx.questionVersion.update({
      where: { id: latestVersion.id },
      data: {
        stem: body.stem ? (body.stem as Prisma.InputJsonValue) : undefined,
        stemMediaId: body.stemMediaId !== undefined ? body.stemMediaId : undefined,
        explanation: body.explanation,
        hasMath: body.hasMath,
        topicId,
        difficulty: body.difficulty,
        marks: body.marks,
        status: body.status,
        answerSource: 'LECTURER',
        ...(isApproved
          ? { approvedBy: actor.actorId, approvedAt: new Date() }
          : {}),
      },
    });

    if (body.options) {
      await tx.option.deleteMany({ where: { versionId: latestVersion.id } });
      await tx.option.createMany({
        data: body.options.map((o) => ({
          versionId: latestVersion.id,
          position: o.position,
          body: o.body as Prisma.InputJsonValue,
          mediaId: o.mediaId ?? null,
          isCorrect: o.isCorrect,
        })),
      });
    }

    if (body.courseId !== undefined || body.subjectId !== undefined) {
      await tx.question.update({
        where: { id },
        data: {
          ...(body.courseId !== undefined ? { courseId: body.courseId, subjectId: null } : {}),
          ...(body.subjectId !== undefined ? { subjectId: body.subjectId, courseId: null } : {}),
        },
      });
    }

    await writeAudit(tx, actor, {
      action: 'question.update',
      targetType: 'Question',
      targetId: id,
      before: { versionNo: latestVersion.versionNo, status: latestVersion.status },
      after: { versionId: targetVersionId, updatedBy: actor.actorId },
    });

    return tx.question.findUnique({
      where: { id },
      include: { versions: { where: { id: targetVersionId }, include: versionInclude } },
    });
  });

  res.json({
    data: updated
      ? {
          ...updated,
          version: updated.versions[0] ? presentVersion(updated.versions[0]) : null,
        }
      : null,
  });
};

// --- Question Summary ---
export const getQuestionsSummary = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;

  const userQuestions = await prisma.question.findMany({
    where: ownedQuestionWhere(userId),
    select: { currentVersionId: true },
  });

  const currentVersionIds = userQuestions
    .map((q) => q.currentVersionId)
    .filter((id): id is string => id !== null);

  const versions = await prisma.questionVersion.findMany({
    where: { id: { in: currentVersionIds } },
    select: { difficulty: true },
  });

  const formatted = { total: 0, EASY: 0, MEDIUM: 0, HARD: 0 };
  for (const v of versions) {
    const key = v.difficulty;
    if (key === 'EASY' || key === 'MEDIUM' || key === 'HARD') {
      formatted[key]++;
      formatted.total++;
    }
  }

  res.json({ data: formatted });
};

const bulkApproveSchema = z.object({
  courseId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  questionIds: z.array(z.string().uuid()).optional(),
});

export const bulkApproveQuestions = async (req: Request, res: Response) => {
  const actor = actorFrom(req, res);
  const body = bulkApproveSchema.parse(req.body);

  const scope: Scope = {
    courseId: body.courseId,
    subjectId: body.subjectId,
  };

  if (scope.courseId || scope.subjectId) {
    await assertScopeAccess(prisma, actor.actorId, scope);
  }

  const where: Prisma.QuestionWhereInput = {
    AND: [
      ownedQuestionWhere(actor.actorId),
      ...(body.courseId ? [{ courseId: body.courseId }] : []),
      ...(body.subjectId ? [{ subjectId: body.subjectId }] : []),
      ...(body.questionIds && body.questionIds.length > 0 ? [{ id: { in: body.questionIds } }] : []),
    ],
  };

  // Find candidate questions
  const questions = await prisma.question.findMany({
    where,
    select: {
      id: true,
      currentVersionId: true,
    },
  });

  const versionIds = questions
    .map((q) => q.currentVersionId)
    .filter((id): id is string => Boolean(id));

  if (versionIds.length === 0) {
    return res.json({ data: { count: 0, message: 'No questions found to approve' } });
  }

  // Update all current versions that are in DRAFT or PENDING or RETURNED to APPROVED
  const updateResult = await prisma.questionVersion.updateMany({
    where: {
      id: { in: versionIds },
      status: { in: ['DRAFT', 'PENDING', 'RETURNED'] },
    },
    data: {
      status: 'APPROVED',
      approvedBy: actor.actorId,
      approvedAt: new Date(),
    },
  });

  await writeAudit(prisma, actor, {
    action: 'question.bulk_approve',
    targetType: 'Question',
    targetId: body.courseId ?? body.subjectId ?? 'all',
    after: { count: updateResult.count },
  });

  res.json({
    data: {
      count: updateResult.count,
      message: `Successfully approved ${updateResult.count} question(s)`,
    },
  });
};

export const deleteQuestion = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const actor = actorFrom(req, res);

  const question = await prisma.question.findUnique({
    where: { id },
    include: {
      versions: { select: { id: true } },
    },
  });

  if (!question) {
    throw Errors.notFound('Question');
  }

  // Author, course assignment, or global admin check
  const isAdmin = req.auth?.roles.includes('ADMIN');
  if (!isAdmin) {
    await assertScopeAccess(prisma, actor.actorId, {
      courseId: question.courseId ?? undefined,
      subjectId: question.subjectId ?? undefined,
    });
  }

  // Prevent deletion if the question has already been delivered to candidates
  const versionIds = question.versions.map((v) => v.id);
  const inAttempt = await prisma.attemptQuestion.findFirst({
    where: { questionVersionId: { in: versionIds } },
    select: { attemptId: true },
  });

  if (inAttempt) {
    throw Errors.conflict(
      'QUESTION_IN_USE',
      'This question cannot be deleted because it is recorded in candidate examination attempts.',
    );
  }

  await prisma.$transaction(async (tx) => {
    // Break cycle with currentVersionId
    await tx.question.update({
      where: { id },
      data: { currentVersionId: null },
    });

    if (versionIds.length > 0) {
      await tx.moderationReview.deleteMany({
        where: { targetType: 'QUESTION_VERSION', targetId: { in: versionIds } },
      });
      await tx.examQuestion.deleteMany({
        where: { questionVersionId: { in: versionIds } },
      });
      await tx.option.deleteMany({
        where: { versionId: { in: versionIds } },
      });
      await tx.questionVersion.deleteMany({
        where: { questionId: id },
      });
    }

    await tx.question.delete({
      where: { id },
    });

    await writeAudit(tx, actor, {
      action: 'question.delete',
      targetType: 'Question',
      targetId: id,
      before: { courseId: question.courseId, subjectId: question.subjectId },
    });
  });

  res.json({
    data: {
      id,
      success: true,
      message: 'Question deleted successfully.',
    },
  });
};


