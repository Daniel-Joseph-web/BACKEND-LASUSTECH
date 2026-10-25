import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { Prisma } from '@lasustech-cbt/db';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { uuidParam } from '../../lib/http';
import { env } from '../../config/env';
import { mediaUrl, mediaView } from '../../lib/media';
import { notifyUsers } from '../../lib/notify';
import {
  assertExamAccess,
  ExamScope,
  materializePaper,
  ownedExamWhere,
  PaperSectionInput,
} from './exams.service';

// --- Validation Schemas ---
const examRuleSchema = z.object({
  mode: z.enum(['BY_RULE', 'FIXED']).default('BY_RULE'),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  topicId: z.string().uuid().optional(),
  count: z.number().int().min(1),
  marks: z.coerce.number().min(0.5),
  questionIds: z.array(z.string().uuid()).optional(),
});

const examSectionSchema = z.object({
  title: z.string().min(1),
  timerMode: z.enum(['SHARED', 'OWN']).default('SHARED'),
  minutes: z.number().int().min(1).optional(),
  weight: z.coerce.number().min(0.1).default(1.0),
  rules: z.array(examRuleSchema).min(1),
});

const gradeBandSchema = z.object({
  grade: z.enum(['A', 'B', 'C', 'D', 'E', 'F']),
  minPercent: z.coerce.number().min(0).max(100),
  maxPercent: z.coerce.number().min(0).max(100),
  label: z.string().max(40).optional(),
});

const settingsSchema = z
  .object({
    shuffleQuestions: z.boolean().default(true),
    shuffleOptions: z.boolean().default(true),
    strictMode: z.boolean().optional(),
    showResults: z.boolean().default(true),
    allowRetake: z.boolean().default(false),
    maxAttempts: z.number().int().min(1).max(20).default(1),
    gradeBands: z.array(gradeBandSchema).max(10).optional(),
  })
  .passthrough();

const createExamSchema = z
  .object({
    courseId: z.string().uuid().optional(),
    subjectId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(250),
    kind: z
      .enum([
        'MID_SEMESTER',
        'END_OF_SEMESTER',
        'MOCK',
        'QUIZ',
        'RESIT',
        'SUPPLEMENTARY',
        'CUSTOM',
      ])
      .default('CUSTOM'),
    kindLabel: z.string().trim().max(120).optional(),
    audience: z.enum(['INSTITUTIONAL', 'PUBLIC']).default('INSTITUTIONAL'),
    institutionName: z.string().trim().max(200).optional(),
    levelLabel: z.string().trim().max(80).optional(),
    examBoard: z.string().trim().max(120).optional(),
    instructions: z.record(z.string(), z.unknown()).optional(),
    durationMin: z.number().int().min(1).max(600).optional(),
    passMark: z.coerce.number().min(0).max(100).optional(),
    // prefault, not default: Zod 4 types `.default()` against the *output*
    // type, where every settings key is required. `prefault` parses the given
    // value through the schema as input, so `{}` fills in the defaults below.
    settings: settingsSchema.prefault({}),
    sections: z.array(examSectionSchema).min(1),
    publicOpensAt: z.iso.datetime({ offset: true }).optional(),
    publicClosesAt: z.iso.datetime({ offset: true }).optional(),
    accessCode: z.string().trim().min(3).max(64).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.courseId && !data.subjectId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a course or a subject.',
        path: ['courseId'],
      });
    }
    if (data.courseId && data.subjectId) {
      ctx.addIssue({
        code: 'custom',
        message: 'An exam belongs to either a course or a subject, not both.',
        path: ['subjectId'],
      });
    }
    if (data.audience === 'INSTITUTIONAL' && !data.courseId) {
      ctx.addIssue({
        code: 'custom',
        message: 'Institution exams must be attached to a course. Use a public exam for subjects.',
        path: ['audience'],
      });
    }
    if (data.audience === 'PUBLIC' && !data.durationMin) {
      ctx.addIssue({
        code: 'custom',
        message: 'A public exam needs a duration.',
        path: ['durationMin'],
      });
    }
    if (
      data.publicOpensAt &&
      data.publicClosesAt &&
      new Date(data.publicClosesAt) <= new Date(data.publicOpensAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The closing time must be after the opening time.',
        path: ['publicClosesAt'],
      });
    }
  });

// --- Shared presentation ---
const questionInclude = {
  topic: { select: { id: true, name: true } },
  stemMedia: true,
  options: { orderBy: { position: 'asc' as const }, include: { media: true } },
} satisfies Prisma.QuestionVersionInclude;

const examDetailInclude = {
  course: { select: { id: true, code: true, title: true, level: true } },
  subject: { select: { id: true, name: true, code: true, level: true, institution: true } },
  sections: {
    orderBy: { position: 'asc' as const },
    include: {
      rules: true,
      questions: {
        orderBy: { position: 'asc' as const },
        include: { version: { include: questionInclude } },
      },
    },
  },
  sittings: {
    where: { isPublic: false },
    select: { id: true, startsAt: true, endsAt: true, status: true },
    orderBy: { startsAt: 'asc' as const },
  },
} satisfies Prisma.ExamInclude;

type ExamDetail = Prisma.ExamGetPayload<{ include: typeof examDetailInclude }>;

const presentQuestion = (version: ExamDetail['sections'][number]['questions'][number]['version']) => ({
  id: version.id,
  stem: version.stem,
  stemMedia: mediaView(version.stemMedia),
  stemMediaUrl: version.stemMedia ? mediaUrl(version.stemMedia.id) : null,
  explanation: version.explanation,
  difficulty: version.difficulty,
  marks: version.marks,
  status: version.status,
  answerSource: version.answerSource,
  aiModel: version.aiModel,
  topic: version.topic,
  options: version.options.map((option) => ({
    id: option.id,
    position: option.position,
    body: option.body,
    isCorrect: option.isCorrect,
    media: mediaView(option.media),
    mediaUrl: option.media ? mediaUrl(option.media.id) : null,
  })),
});

const presentExam = (exam: ExamDetail & { _count?: { sections: number } }) => ({
  id: exam.id,
  title: exam.title,
  kind: exam.kind,
  kindLabel: exam.kindLabel,
  audience: exam.audience,
  status: exam.status,
  courseId: exam.courseId,
  subjectId: exam.subjectId,
  course: exam.course,
  subject: exam.subject,
  ownerLabel: exam.course
    ? `${exam.course.code} — ${exam.course.title}`
    : `${exam.subject?.name ?? 'Custom exam'}${exam.subject?.level ? ` (${exam.subject.level})` : ''}`,
  institutionName: exam.institutionName,
  levelLabel: exam.levelLabel,
  examBoard: exam.examBoard,
  instructions: exam.instructions,
  durationMin: exam.durationMin,
  passMark: exam.passMark,
  settings: exam.settings,
  publicSlug: exam.publicSlug,
  requiresCode: Boolean(exam.publicAccessCodeHash),
  publicOpensAt: exam.publicOpensAt,
  publicClosesAt: exam.publicClosesAt,
  publishedAt: exam.publishedAt,
  createdAt: exam.createdAt,
  publicUrl:
    exam.audience === 'PUBLIC' && exam.publicSlug
      ? `${env.WEB_ORIGIN.replace(/\/$/, '')}/exam/${exam.publicSlug}`
      : null,
  sittings: exam.sittings,
  sections: exam.sections.map((section) => ({
    id: section.id,
    position: section.position,
    title: section.title,
    timerMode: section.timerMode,
    minutes: section.minutes,
    weight: section.weight,
    rules: section.rules,
    questions: section.questions.map((q) => ({
      position: q.position,
      questionVersionId: q.questionVersionId,
      ...presentQuestion(q.version),
    })),
  })),
});

const detailById = (id: string) =>
  prisma.exam.findUnique({ where: { id }, include: examDetailInclude });

// --- 1. Fetch Available Question Pool ---
export const getAvailableQuestionCounts = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const courseId = typeof req.query.courseId === 'string' ? req.query.courseId : undefined;
  const subjectId = typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined;

  if (!courseId && !subjectId) {
    throw Errors.badRequest('MISSING_SCOPE', 'courseId or subjectId is required.');
  }

  const scope: ExamScope = courseId ? { courseId } : { subjectId };
  await assertExamAccess(prisma, userId, scope);

  const questions = await prisma.question.findMany({
    where: { ...(courseId ? { courseId } : { subjectId }), currentVersionId: { not: null } },
    select: { currentVersionId: true },
  });
  const currentVersionIds = questions
    .map((q) => q.currentVersionId)
    .filter((id): id is string => id !== null);

  const pool = await prisma.questionVersion.groupBy({
    by: ['topicId', 'difficulty'],
    where: { id: { in: currentVersionIds }, status: 'APPROVED' },
    _count: { id: true },
  });

  res.json({ data: pool });
};

// --- 2. Create + publish an exam (no moderation) ---
export const createExam = async (req: Request, res: Response) => {
  const body = createExamSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const scope: ExamScope = body.courseId
    ? { courseId: body.courseId }
    : { subjectId: body.subjectId };
  await assertExamAccess(prisma, actor.actorId, scope);

  const session = body.courseId
    ? await prisma.academicSession.findFirst({ where: { isCurrent: true }, select: { id: true } })
    : null;
  if (body.courseId && !session) {
    throw Errors.conflict('NO_SESSION', 'No active academic session. Ask an administrator to activate one.');
  }

  const now = new Date();
  const slug = body.audience === 'PUBLIC' ? crypto.randomBytes(16).toString('base64url') : null;
  const codeHash = body.accessCode ? await bcrypt.hash(body.accessCode, 10) : null;

  const settings = {
    ...body.settings,
    ...(body.durationMin ? { durationMin: body.durationMin } : {}),
    ...(body.passMark !== undefined ? { passMark: body.passMark } : {}),
  } as Prisma.InputJsonValue;

  const exam = await prisma.$transaction(async (tx) => {
    const created = await tx.exam.create({
      data: {
        courseId: body.courseId,
        subjectId: body.subjectId,
        sessionId: session?.id ?? null,
        createdBy: actor.actorId,
        title: body.title,
        kind: body.kind,
        kindLabel: body.kindLabel,
        audience: body.audience,
        institutionName: body.institutionName,
        levelLabel: body.levelLabel,
        examBoard: body.examBoard,
        instructions: (body.instructions ?? {}) as Prisma.InputJsonValue,
        settings,
        status: 'APPROVED',
        publishedAt: now,
        durationMin: body.durationMin,
        passMark: body.passMark !== undefined ? new Prisma.Decimal(body.passMark) : null,
        publicSlug: slug,
        publicAccessCodeHash: codeHash,
        publicOpensAt: body.publicOpensAt ? new Date(body.publicOpensAt) : null,
        publicClosesAt: body.publicClosesAt ? new Date(body.publicClosesAt) : null,
      },
    });

    await materializePaper(tx, created.id, scope, body.sections as PaperSectionInput[]);

    if (body.audience === 'PUBLIC') {
      const startsAt = body.publicOpensAt ? new Date(body.publicOpensAt) : now;
      const endsAt = body.publicClosesAt
        ? new Date(body.publicClosesAt)
        : new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
      await tx.sitting.create({
        data: {
          examId: created.id,
          startsAt,
          endsAt,
          durationMin: body.durationMin ?? 60,
          timerMode: 'PER_STUDENT_START',
          lateGraceMin: 0,
          lateCutoffMin: 0,
          clockPolicy: 'RUNNING',
          maxPauseMin: 0,
          reconnectGraceSec: 60,
          venue: null,
          venueId: null,
          isPublic: true,
          deliveryMode: 'REMOTE',
          requireWebcam: false,
          requireSeb: false,
          // The candidate code lives on Exam.publicAccessCodeHash; this column is
          // NOT NULL, so store a random value that can never match.
          accessCodeHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
          status: 'OPEN',
        },
      });
    }

    await writeAudit(tx, actor, {
      action: 'exam.publish',
      targetType: 'Exam',
      targetId: created.id,
      after: {
        title: created.title,
        audience: created.audience,
        sections: body.sections.length,
        publicSlug: slug,
      },
    });

    // Notify administrators and exam officers that an exam was created and needs scheduling
    const adminRoles = await tx.userRole.findMany({
      where: {
        role: { key: { in: ['SUPER_ADMIN', 'ADMIN', 'EXAM_OFFICER'] } },
      },
      select: { userId: true },
    });
    const adminUserIds = [...new Set(adminRoles.map((r) => r.userId))];

    if (adminUserIds.length > 0) {
      const courseLabel = body.courseId
        ? (await tx.course.findUnique({ where: { id: body.courseId }, select: { code: true } }))?.code ?? 'Course'
        : 'Subject';

      const lecturerName = (req as any).user?.names || 'A lecturer';
      await notifyUsers(tx, adminUserIds, {
        type: 'SYSTEM',
        title: `New Exam Live: ${created.title}`,
        body: `Lecturer ${lecturerName} published exam "${created.title}" (${courseLabel}). Questions are live and ready for sitting scheduling.`,
        meta: {
          kind: 'EXAM_CREATED',
          examId: created.id,
          href: '/admin/schedule',
        },
      });
    }

    return created;
  });

  const detail = await detailById(exam.id);
  res.status(201).json({
    data: {
      exam: detail ? presentExam(detail) : null,
      publicUrl:
        body.audience === 'PUBLIC' && slug
          ? `${env.WEB_ORIGIN.replace(/\/$/, '')}/exam/${slug}`
          : null,
    },
  });
};

// --- 3. Detail ---
export const getExamById = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const exam = await prisma.exam.findFirst({
    where: { id, ...ownedExamWhere(req.auth!.userId) },
    include: examDetailInclude,
  });
  if (!exam) throw Errors.notFound('Exam');
  res.json({ data: presentExam(exam) });
};

// --- 4. Update metadata/settings (paper is editable until someone sits it) ---
const patchExamSchema = z.object({
  title: z.string().trim().min(1).max(250).optional(),
  kind: z
    .enum([
      'MID_SEMESTER',
      'END_OF_SEMESTER',
      'MOCK',
      'QUIZ',
      'RESIT',
      'SUPPLEMENTARY',
      'CUSTOM',
    ])
    .optional(),
  kindLabel: z.string().trim().max(120).nullish(),
  instructions: z.record(z.string(), z.unknown()).optional(),
  durationMin: z.number().int().min(1).max(600).nullish(),
  passMark: z.coerce.number().min(0).max(100).nullish(),
  settings: settingsSchema.optional(),
  institutionName: z.string().trim().max(200).nullish(),
  levelLabel: z.string().trim().max(80).nullish(),
  examBoard: z.string().trim().max(120).nullish(),
  publicOpensAt: z.iso.datetime({ offset: true }).nullish(),
  publicClosesAt: z.iso.datetime({ offset: true }).nullish(),
  accessCode: z.string().trim().min(3).max(64).nullish(),
  sections: z.array(examSectionSchema).min(1).optional(),
});

export const updateExam = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = patchExamSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const exam = await prisma.exam.findFirst({
    where: { id, ...ownedExamWhere(actor.actorId) },
    select: {
      id: true,
      audience: true,
      courseId: true,
      subjectId: true,
      status: true,
      _count: { select: { sittings: true } },
    },
  });
  if (!exam) throw Errors.notFound('Exam');

  const attempts = await prisma.attempt.count({ where: { sitting: { examId: id } } });
  if (attempts > 0) {
    throw Errors.conflict('EXAM_IN_USE', 'This exam has candidate attempts and can no longer be edited.');
  }

  const scope: ExamScope = exam.courseId
    ? { courseId: exam.courseId }
    : { subjectId: exam.subjectId };

  await prisma.$transaction(async (tx) => {
    await tx.exam.update({
      where: { id },
      data: {
        title: body.title,
        kind: body.kind,
        kindLabel: body.kindLabel,
        instructions: body.instructions as Prisma.InputJsonValue | undefined,
        durationMin: body.durationMin,
        passMark:
          body.passMark === undefined
            ? undefined
            : body.passMark === null
              ? null
              : new Prisma.Decimal(body.passMark),
        settings: body.settings as Prisma.InputJsonValue | undefined,
        institutionName: body.institutionName,
        levelLabel: body.levelLabel,
        examBoard: body.examBoard,
        publicOpensAt: body.publicOpensAt ? new Date(body.publicOpensAt) : body.publicOpensAt,
        publicClosesAt: body.publicClosesAt ? new Date(body.publicClosesAt) : body.publicClosesAt,
        publicAccessCodeHash:
          body.accessCode === undefined
            ? undefined
            : body.accessCode === null
              ? null
              : await bcrypt.hash(body.accessCode, 10),
      },
    });

    if (body.sections) {
      const sections = await tx.examSection.findMany({
        where: { examId: id },
        select: { id: true },
      });
      const sectionIds = sections.map((s) => s.id);
      if (sectionIds.length) {
        await tx.examQuestion.deleteMany({ where: { sectionId: { in: sectionIds } } });
        await tx.examRule.deleteMany({ where: { sectionId: { in: sectionIds } } });
        await tx.examSection.deleteMany({ where: { examId: id } });
      }
      await materializePaper(tx, id, scope, body.sections as PaperSectionInput[]);
    }

    await writeAudit(tx, actor, {
      action: 'exam.update',
      targetType: 'Exam',
      targetId: id,
      after: { title: body.title ?? null, sectionsReplaced: Boolean(body.sections) },
    });
  });

  const detail = await detailById(id);
  res.json({ data: detail ? presentExam(detail) : null });
};

// --- 5. Delete a never-sat exam ---
export const deleteExam = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const actor = actorFrom(req, res);

  const exam = await prisma.exam.findFirst({
    where: { id, ...ownedExamWhere(actor.actorId) },
    select: {
      id: true,
      title: true,
      sittings: {
        select: {
          id: true,
          _count: { select: { attempts: true, batches: true, incidents: true } },
        },
      },
    },
  });
  if (!exam) throw Errors.notFound('Exam');

  const inUse = exam.sittings.some(
    (s) => s._count.attempts || s._count.batches || s._count.incidents,
  );
  if (inUse) {
    throw Errors.conflict('EXAM_IN_USE', 'This exam has attempts or results. Archive it instead of deleting.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.sittingInvigilator.deleteMany({ where: { sitting: { examId: id } } });
    await tx.sittingStudent.deleteMany({ where: { sitting: { examId: id } } });
    await tx.sitting.deleteMany({ where: { examId: id } });
    await tx.exam.delete({ where: { id } });
    await writeAudit(tx, actor, {
      action: 'exam.delete',
      targetType: 'Exam',
      targetId: id,
      before: { title: exam.title },
    });
  });

  res.status(204).end();
};

// --- Legacy draft endpoint (kept for compatibility) ---
const saveDraftSchema = z.object({
  courseId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  title: z.string().min(1),
  instructions: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).default({ shuffleQuestions: true, strictMode: true }),
  sections: z.array(examSectionSchema).optional(),
});

export const saveExamDraft = async (req: Request, res: Response) => {
  const examId = req.params.id === 'new' ? undefined : z.string().uuid().parse(req.params.id);
  const body = saveDraftSchema.parse(req.body);
  const actor = actorFrom(req, res);
  const scope: ExamScope = body.courseId
    ? { courseId: body.courseId }
    : { subjectId: body.subjectId };

  const currentSession = body.courseId
    ? await prisma.academicSession.findFirst({ where: { isCurrent: true } })
    : null;

  const savedExam = await prisma.$transaction(async (tx) => {
    if (examId) {
      const exam = await tx.exam.findFirst({
        where: { id: examId, ...ownedExamWhere(actor.actorId) },
        include: { sections: true },
      });
      if (!exam) throw Errors.notFound('Exam');
      if (exam.status !== 'DRAFT') {
        throw Errors.conflict('LOCKED', 'Only Draft exams can be edited here.');
      }
      const sectionIds = exam.sections.map((s) => s.id);
      if (sectionIds.length > 0) {
        await tx.examRule.deleteMany({ where: { sectionId: { in: sectionIds } } });
        await tx.examSection.deleteMany({ where: { examId } });
      }
      return tx.exam.update({
        where: { id: examId },
        data: {
          title: body.title,
          instructions: body.instructions as Prisma.InputJsonValue,
          settings: body.settings as Prisma.InputJsonValue,
        },
      });
    }

    await assertExamAccess(tx, actor.actorId, scope);
    return tx.exam.create({
      data: {
        courseId: body.courseId,
        subjectId: body.subjectId,
        sessionId: currentSession?.id ?? null,
        createdBy: actor.actorId,
        title: body.title,
        kind: 'CUSTOM',
        instructions: body.instructions as Prisma.InputJsonValue,
        settings: body.settings as Prisma.InputJsonValue,
        status: 'APPROVED',
        publishedAt: new Date(),
      },
    });
  });

  res.json({ data: savedExam });
};

// --- Legacy submit endpoint: now publishes immediately (no moderation) ---
export const submitExamForModeration = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const actor = actorFrom(req, res);

  const exam = await prisma.exam.findFirst({
    where: { id, ...ownedExamWhere(actor.actorId) },
    include: { sections: { include: { rules: true } } },
  });
  if (!exam) throw Errors.notFound('Exam');

  // Exams created through POST /lecturer/exams are already published. Old
  // clients may still call this route; publishing twice would duplicate the
  // paper, so return the existing exam untouched.
  if (exam.status === 'APPROVED') {
    return res.json({ data: exam });
  }

  if (exam.sections.length === 0) {
    throw Errors.badRequest('NO_SECTIONS', 'Exam must have at least one section.');
  }

  const scope: ExamScope = exam.courseId
    ? { courseId: exam.courseId }
    : { subjectId: exam.subjectId };

  const published = await prisma.$transaction(async (tx) => {
    // Re-materialising adds new sections, so clear the previous paper first.
    const existingSections = await tx.examSection.findMany({
      where: { examId: id },
      select: { id: true },
    });
    const existingIds = existingSections.map((section) => section.id);
    if (existingIds.length) {
      await tx.examQuestion.deleteMany({ where: { sectionId: { in: existingIds } } });
      await tx.examRule.deleteMany({ where: { sectionId: { in: existingIds } } });
      await tx.examSection.deleteMany({ where: { examId: id } });
    }

    await materializePaper(
      tx,
      id,
      scope,
      exam.sections.map((section) => ({
        title: section.title,
        timerMode: section.timerMode,
        minutes: section.minutes ?? undefined,
        weight: Number(section.weight),
        rules: section.rules.map((rule) => ({
          mode: rule.mode,
          difficulty: rule.difficulty ?? undefined,
          topicId: rule.topicId ?? undefined,
          count: rule.count,
          marks: Number(rule.marks),
        })),
      })),
    );

    const updated = await tx.exam.update({
      where: { id },
      data: {
        status: 'APPROVED',
        publishedAt: new Date(),
        ...(exam.audience === 'PUBLIC' && !exam.publicSlug
          ? { publicSlug: crypto.randomBytes(16).toString('base64url') }
          : {}),
      },
    });

    await writeAudit(tx, actor, {
      action: 'exam.publish',
      targetType: 'Exam',
      targetId: id,
      after: { status: 'APPROVED' },
    });

    return updated;
  });

  res.json({ data: published });
};
