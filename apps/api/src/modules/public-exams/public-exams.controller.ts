import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { Prisma } from '@lasustech-cbt/db';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { uuidParam, blankToUndef } from '../../lib/http';
import { mediaUrl, mediaView } from '../../lib/media';
import { publishRealtimeEvent } from '../../lib/realtime';
import { bearerToken, signAttemptToken, verifyAttemptToken } from './attempt-token';
import { readSelectedPositions, scoreAttempt } from './scoring';

const startSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(120),
  email: z.preprocess(blankToUndef, z.string().trim().email().max(200).optional()),
  accessCode: z.preprocess(blankToUndef, z.string().trim().max(64).optional()),
});

const answerSchema = z.object({
  questionVersionId: z.string().uuid(),
  positions: z.array(z.number().int().min(0).max(20)).max(10),
  flagged: z.boolean().optional(),
});

const examMetaInclude = {
  course: { select: { id: true, code: true, title: true, level: true } },
  subject: { select: { id: true, name: true, code: true, level: true, institution: true } },
  sections: {
    orderBy: { position: 'asc' as const },
    include: { _count: { select: { questions: true } } },
  },
  sittings: { where: { isPublic: true }, take: 1 },
} satisfies Prisma.ExamInclude;

type ExamMeta = Prisma.ExamGetPayload<{ include: typeof examMetaInclude }>;

const settingsOf = (exam: { settings: Prisma.JsonValue }) =>
  exam.settings && typeof exam.settings === 'object' && !Array.isArray(exam.settings)
    ? (exam.settings as Record<string, unknown>)
    : {};

const boolSetting = (settings: Record<string, unknown>, key: string, fallback: boolean) =>
  typeof settings[key] === 'boolean' ? (settings[key] as boolean) : fallback;

function windowState(exam: { publicOpensAt: Date | null; publicClosesAt: Date | null }, now = new Date()) {
  if (exam.publicOpensAt && now < exam.publicOpensAt) return 'NOT_OPEN' as const;
  if (exam.publicClosesAt && now > exam.publicClosesAt) return 'CLOSED' as const;
  return 'OPEN' as const;
}

const questionCount = (exam: ExamMeta) =>
  exam.sections.reduce((total, section) => total + section._count.questions, 0);

const examMeta = (exam: ExamMeta) => {
  const settings = settingsOf(exam);
  return {
    slug: exam.publicSlug,
    title: exam.title,
    kind: exam.kind,
    kindLabel: exam.kindLabel ?? exam.kind.replaceAll('_', ' ').toLowerCase(),
    course: exam.course,
    subject: exam.subject,
    ownerLabel: exam.subject
      ? `${exam.subject.name}${exam.subject.level ? ` (${exam.subject.level})` : ''}`
      : exam.course
        ? `${exam.course.code} — ${exam.course.title}`
        : exam.title,
    institutionName: exam.institutionName ?? exam.subject?.institution ?? null,
    levelLabel: exam.levelLabel ?? exam.subject?.level ?? null,
    examBoard: exam.examBoard,
    instructions: exam.instructions,
    durationMin: exam.durationMin,
    passMark: exam.passMark != null ? Number(exam.passMark) : null,
    questionCount: questionCount(exam),
    requiresCode: Boolean(exam.publicAccessCodeHash),
    opensAt: exam.publicOpensAt,
    closesAt: exam.publicClosesAt,
    showResults: boolSetting(settings, 'showResults', true),
    allowRetake: boolSetting(settings, 'allowRetake', false),
    state: windowState(exam),
  };
};

async function findPublicExam(slug: string) {
  const exam = await prisma.exam.findFirst({
    where: { publicSlug: slug, audience: 'PUBLIC', status: 'APPROVED' },
    include: examMetaInclude,
  });
  if (!exam) throw Errors.notFound('Exam');
  return exam;
}

export const getPublicExam = async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '');
  const exam = await findPublicExam(slug);
  res.json({ data: examMeta(exam) });
};

// --- Attempt paper ---
const attemptInclude = {
  sitting: { include: { exam: { include: examMetaInclude } } },
  questions: {
    orderBy: { position: 'asc' as const },
    include: {
      questionVersion: {
        include: {
          question: { select: { answerFormat: true } },
          stemMedia: true,
          options: { orderBy: { position: 'asc' as const }, include: { media: true } },
        },
      },
    },
  },
  answers: true,
  results: { where: { isCurrent: true }, take: 1 },
} satisfies Prisma.AttemptInclude;

type AttemptWithPaper = Prisma.AttemptGetPayload<{ include: typeof attemptInclude }>;

const presentPaper = (attempt: AttemptWithPaper) => {
  const saved = new Map(attempt.answers.map((answer) => [answer.questionVersionId, answer]));
  return attempt.questions.map((question) => {
    const version = question.questionVersion;
    const optionsByPosition = new Map(version.options.map((option) => [option.position, option]));
    const savedAnswer = saved.get(version.id);
    return {
      questionVersionId: version.id,
      position: question.position,
      sectionId: question.sectionId,
      marks: Number(question.weightedMarks),
      answerFormat: version.question.answerFormat,
      stem: version.stem,
      stemMedia: mediaView(version.stemMedia),
      stemMediaUrl: version.stemMedia ? mediaUrl(version.stemMedia.id) : null,
      // Correct answers and explanations are never sent to a candidate.
      options: question.optionOrder
        .map((position) => optionsByPosition.get(position))
        .filter((option): option is NonNullable<typeof option> => Boolean(option))
        .map((option) => ({
          id: option.id,
          position: option.position,
          body: option.body,
          media: mediaView(option.media),
          mediaUrl: option.media ? mediaUrl(option.media.id) : null,
        })),
      saved: savedAnswer
        ? {
            positions: readSelectedPositions(savedAnswer.value),
            flagged: savedAnswer.flagged,
            clientSeq: Number(savedAnswer.clientSeq),
          }
        : null,
    };
  });
};

const remainingSec = (attempt: { deadlineAt: Date | null }) =>
  attempt.deadlineAt ? Math.max(0, Math.floor((attempt.deadlineAt.getTime() - Date.now()) / 1000)) : null;

const attemptResponse = (attempt: AttemptWithPaper, token: string) => {
  const settings = settingsOf(attempt.sitting.exam);
  const current = attempt.results[0];
  // `showResults` hides the score from the candidate; the attempt token would
  // otherwise let them read it straight from this response.
  const reveal = boolSetting(settings, 'showResults', true);
  return {
    attemptId: attempt.id,
    sittingId: attempt.sittingId,
    token,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    remainingSec: remainingSec(attempt),
    questionCount: attempt.questionCount,
    totalMarks: Number(attempt.totalMarks),
    exam: examMeta(attempt.sitting.exam),
    requireWebcam: attempt.sitting.requireWebcam ?? false,
    antiCheatEnabled: boolSetting(settings, 'antiCheatEnabled', true),
    questions: presentPaper(attempt),
    result:
      current && reveal
        ? {
            rawScore: Number(current.rawScore),
            maxScore: Number(current.maxScore),
            percent: Number(current.percent),
            grade: current.grade,
          }
        : null,
  };
};

const loadAttempt = async (id: string) => {
  const attempt = await prisma.attempt.findUnique({ where: { id }, include: attemptInclude });
  if (!attempt) throw Errors.notFound('Attempt');
  return attempt;
};

/** Verifies the scoped bearer token and that it belongs to this attempt. */
async function authorisedAttempt(req: Request) {
  const id = uuidParam(req, 'id');
  const payload = verifyAttemptToken(bearerToken(req.headers.authorization));
  if (payload.attemptId !== id) throw Errors.forbidden();
  const attempt = await loadAttempt(id);
  if (attempt.studentId !== payload.sub) throw Errors.forbidden();
  return attempt;
}

function tokenTtl(attempt: { deadlineAt: Date | null }) {
  if (!attempt.deadlineAt) return 4 * 60 * 60;
  return Math.max(60 * 60, Math.ceil((attempt.deadlineAt.getTime() - Date.now()) / 1000) + 30 * 60);
}

async function resumeOrCreateSitting(exam: ExamMeta) {
  if (exam.sittings[0]) return exam.sittings[0];
  // Should have been created at publish time; this keeps older public exams
  // (published before the hidden sitting existed) working.
  const settings = settingsOf(exam);
  const durationMin = exam.durationMin ?? 60;
  const now = new Date();
  return prisma.sitting.create({
    data: {
      examId: exam.id,
      startsAt: now,
      endsAt: exam.publicClosesAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      durationMin,
      timerMode: 'PER_STUDENT_START',
      lateGraceMin: 0,
      lateCutoffMin: 0,
      clockPolicy: 'RUNNING',
      maxPauseMin: 0,
      reconnectGraceSec: 300,
      venue: null,
      isPublic: true,
      deliveryMode: 'REMOTE',
      requireWebcam: boolSetting(settings, 'requireWebcam', true),
      requireSeb: false,
      accessCodeHash: crypto.randomBytes(32).toString('hex'),
      status: 'OPEN',
    },
  });
}

async function createAttempt(exam: ExamMeta, sittingId: string, studentId: string, guestEmail: string | null) {
  const settings = settingsOf(exam);
  const shuffleQuestions = boolSetting(settings, 'shuffleQuestions', true);
  const shuffleOptions = boolSetting(settings, 'shuffleOptions', true);

  const sections = await prisma.examSection.findMany({
    where: { examId: exam.id },
    orderBy: { position: 'asc' },
    include: {
      questions: {
        orderBy: { position: 'asc' },
        include: { version: { include: { options: { orderBy: { position: 'asc' } } } } },
      },
    },
  });

  const planned: {
    versionId: string;
    sectionId: string;
    marks: number;
    optionOrder: number[];
  }[] = [];

  for (const section of sections) {
    const questions = section.questions.map((question) => ({
      versionId: question.questionVersionId,
      sectionId: section.id,
      marks: Number(question.version.marks),
      optionOrder: (shuffleOptions
        ? shuffle(question.version.options.map((option) => option.position))
        : question.version.options.map((option) => option.position)),
    }));
    planned.push(...(shuffleQuestions ? shuffle(questions) : questions));
  }

  if (!planned.length) {
    throw Errors.conflict(
      'EXAM_HAS_NO_QUESTIONS',
      'This exam has no questions yet. Ask the examiner to add questions before sharing the link.',
    );
  }

  const totalMarks = planned.reduce((sum, question) => sum + question.marks, 0);
  const now = new Date();
  const durationMin = exam.durationMin ?? 60;
  const deadline = new Date(now.getTime() + durationMin * 60 * 1000);
  const cappedDeadline = exam.publicClosesAt && exam.publicClosesAt < deadline ? exam.publicClosesAt : deadline;

  const previousCount = await prisma.attempt.count({ where: { sittingId, studentId } });

  const attempt = await prisma.$transaction(async (tx) => {
    const created = await tx.attempt.create({
      data: {
        sittingId,
        studentId,
        guestEmail,
        attemptNo: previousCount + 1,
        status: 'IN_PROGRESS',
        startedAt: now,
        deadlineAt: cappedDeadline,
        questionCount: planned.length,
        totalMarks: new Prisma.Decimal(totalMarks),
        ipStart: null,
        questions: {
          create: planned.map((question, position) => ({
            position,
            questionVersionId: question.versionId,
            sectionId: question.sectionId,
            weightedMarks: new Prisma.Decimal(question.marks),
            optionOrder: question.optionOrder,
          })),
        },
      },
      include: attemptInclude,
    });

    return created;
  });

  return { attempt, totalMarks };
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// --- Start / resume ---
export const startPublicAttempt = async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '');
  const body = startSchema.parse(req.body);
  const exam = await findPublicExam(slug);

  const state = windowState(exam);
  if (state === 'NOT_OPEN') {
    throw Errors.conflict('EXAM_NOT_OPEN', 'This exam has not opened yet.', {
      opensAt: exam.publicOpensAt,
    });
  }
  if (state === 'CLOSED') {
    throw Errors.conflict('EXAM_CLOSED', 'This exam has closed.', { closesAt: exam.publicClosesAt });
  }

  if (exam.publicAccessCodeHash) {
    const ok = body.accessCode
      ? await bcrypt.compare(body.accessCode, exam.publicAccessCodeHash)
      : false;
    if (!ok) {
      throw Errors.badRequest('ACCESS_CODE_REQUIRED', 'This exam needs the access code from the examiner.');
    }
  }

  const email = body.email?.toLowerCase();

  if (email) {
    const submitted = await prisma.attempt.findFirst({
      where: {
        guestEmail: email,
        sitting: { examId: exam.id },
        status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED', 'EXPIRED'] },
      },
      select: { id: true },
    });
    if (submitted) {
      throw Errors.conflict('ALREADY_TAKEN', 'This email has already taken this exam.');
    }

    // A reload before submitting resumes the same attempt rather than burning
    // a second one (the token is only held in the candidate's browser).
    const resume = await prisma.attempt.findFirst({
      where: {
        guestEmail: email,
        sitting: { examId: exam.id },
        status: { in: ['IN_PROGRESS', 'PAUSED'] },
      },
      include: attemptInclude,
      orderBy: { createdAt: 'desc' },
    });
    if (resume) {
      const token = signAttemptToken(resume.id, resume.studentId, tokenTtl(resume));
      return res.json({ data: attemptResponse(resume, token) });
    }
  }

  const settings = settingsOf(exam);
  const allowRetake = boolSetting(settings, 'allowRetake', false);
  const maxAttempts = typeof settings.maxAttempts === 'number' ? settings.maxAttempts : 1;

  const guest = await resolveGuest(body.name, email);
  const sitting = await resumeOrCreateSitting(exam);

  if (!allowRetake && email) {
    const taken = await prisma.attempt.count({
      where: {
        sittingId: sitting.id,
        studentId: guest.id,
        status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] },
      },
    });
    if (taken > 0) {
      throw Errors.conflict('ALREADY_TAKEN', 'This email has already taken this exam.');
    }
  }
  if (allowRetake) {
    const taken = await prisma.attempt.count({ where: { sittingId: sitting.id, studentId: guest.id } });
    if (taken >= maxAttempts) {
      throw Errors.conflict('MAX_ATTEMPTS', `This exam allows ${maxAttempts} attempt(s).`);
    }
  }

  const { attempt } = await createAttempt(exam, sitting.id, guest.id, email ?? null);
  const token = signAttemptToken(attempt.id, guest.id, tokenTtl(attempt));

  res.status(201).json({ data: attemptResponse(attempt, token) });
};

async function resolveGuest(name: string, email?: string) {
  if (email) {
    const existing = await prisma.user.findFirst({
      where: { email, isGuest: true },
      select: { id: true, names: true },
    });
    if (existing) return existing;
  }

  // Never attach a guest attempt to a staff/student account that happens to
  // share the email; use a separate guest row and leave email null.
  const emailOwner = email
    ? await prisma.user.findFirst({ where: { email }, select: { id: true } })
    : null;

  return prisma.user.create({
    data: {
      names: name,
      email: emailOwner ? null : (email ?? null),
      status: 'ACTIVE',
      isGuest: true,
    },
    select: { id: true, names: true },
  });
}

// --- Read an attempt ---
export const getPublicAttempt = async (req: Request, res: Response) => {
  const attempt = await authorisedAttempt(req);
  const token = signAttemptToken(attempt.id, attempt.studentId, tokenTtl(attempt));

  if (attempt.status === 'IN_PROGRESS' || attempt.status === 'PAUSED') {
    if (attempt.deadlineAt && attempt.deadlineAt.getTime() <= Date.now()) {
      const summary = await prisma.$transaction((tx) =>
        scoreAttempt(tx, attempt.id, { auto: true, endedReason: 'EXPIRED' }),
      );
      const fresh = await loadAttempt(attempt.id);
      return res.json({
        data: { ...attemptResponse(fresh, token), score: visibleScore(fresh, summary) },
      });
    }
  }

  res.json({ data: attemptResponse(attempt, token) });
};

// --- Save one answer ---
export const savePublicAnswer = async (req: Request, res: Response) => {
  const attempt = await authorisedAttempt(req);
  const body = answerSchema.parse(req.body);

  if (attempt.status !== 'IN_PROGRESS' && attempt.status !== 'PAUSED') {
    throw Errors.conflict('ATTEMPT_CLOSED', 'This attempt has already been submitted.');
  }
  if (attempt.deadlineAt && attempt.deadlineAt.getTime() <= Date.now()) {
    await prisma.$transaction((tx) =>
      scoreAttempt(tx, attempt.id, { auto: true, endedReason: 'EXPIRED' }),
    );
    throw Errors.conflict('ATTEMPT_EXPIRED', 'Time is up. Your answers were submitted.');
  }

  const question = attempt.questions.find(
    (item) => item.questionVersionId === body.questionVersionId,
  );
  if (!question) throw Errors.badRequest('UNKNOWN_QUESTION', 'That question is not part of this attempt.');

  const validPositions = new Set(question.optionOrder);
  const positions = [...new Set(body.positions)];
  if (positions.some((position) => !validPositions.has(position))) {
    throw Errors.badRequest('INVALID_OPTION', 'That answer option is not part of this question.');
  }

  const now = new Date();
  const value: Prisma.InputJsonValue = { selected: positions } as Prisma.InputJsonValue;

  const saved = await prisma.$transaction(async (tx) => {
    const current = await tx.attempt.findUnique({
      where: { id: attempt.id },
      select: { lastSyncSeq: true },
    });
    const clientSeq = (current?.lastSyncSeq ?? BigInt(0)) + BigInt(1);

    const answer = await tx.answer.upsert({
      where: {
        attemptId_questionVersionId: {
          attemptId: attempt.id,
          questionVersionId: body.questionVersionId,
        },
      },
      update: {
        value,
        flagged: body.flagged ?? false,
        clientSeq,
        answeredAt: now,
      },
      create: {
        attemptId: attempt.id,
        questionVersionId: body.questionVersionId,
        value,
        flagged: body.flagged ?? false,
        clientSeq,
        answeredAt: now,
      },
    });

    await tx.answerEvent.create({
      data: {
        attemptId: attempt.id,
        questionVersionId: body.questionVersionId,
        value,
        clientSeq,
        clientTs: now,
      },
    });

    await tx.attempt.update({
      where: { id: attempt.id },
      data: { lastSyncSeq: clientSeq, version: { increment: 1 } },
    });

    return answer;
  });

  res.json({
    data: {
      questionVersionId: saved.questionVersionId,
      positions,
      flagged: saved.flagged,
      clientSeq: Number(saved.clientSeq),
      savedAt: saved.answeredAt,
    },
  });
};

// --- Submit ---
export const submitPublicAttempt = async (req: Request, res: Response) => {
  const attempt = await authorisedAttempt(req);

  if (attempt.status !== 'IN_PROGRESS' && attempt.status !== 'PAUSED') {
    const current = attempt.results[0];
    const reveal = boolSetting(settingsOf(attempt.sitting.exam), 'showResults', true);
    return res.json({
      data: {
        submitted: true,
        alreadySubmitted: true,
        ...(current && reveal
          ? {
              rawScore: Number(current.rawScore),
              maxScore: Number(current.maxScore),
              percent: Number(current.percent),
              grade: current.grade,
            }
          : { showResults: reveal }),
      },
    });
  }

  const timedOut = Boolean(attempt.deadlineAt && attempt.deadlineAt.getTime() <= Date.now());
  const summary = await prisma.$transaction((tx) =>
    scoreAttempt(tx, attempt.id, {
      auto: timedOut,
      endedReason: timedOut ? 'EXPIRED' : 'STUDENT_SUBMIT',
    }),
  );

  const fresh = await loadAttempt(attempt.id);
  res.json({
    data: {
      submitted: true,
      autoSubmitted: timedOut,
      ...visibleScore(fresh, summary),
    },
  });
};

/** Respects `showResults`; the score still exists in the database either way. */
function visibleScore(attempt: AttemptWithPaper, summary: Awaited<ReturnType<typeof scoreAttempt>>) {
  const settings = settingsOf(attempt.sitting.exam);
  if (!boolSetting(settings, 'showResults', true)) {
    return { showResults: false as const, grade: null, percent: null, rawScore: null, maxScore: null, passed: null };
  }
  return {
    showResults: true as const,
    rawScore: summary.rawScore,
    maxScore: summary.maxScore,
    percent: summary.percent,
    grade: summary.grade,
    gradeLabel: summary.gradeLabel,
    passed: summary.passed,
  };
}

const lastPublicHeartbeatDbWrite = new Map<string, number>();

export const recordPublicHeartbeat = async (req: Request, res: Response) => {
  const attempt = await authorisedAttempt(req);
  const now = new Date();
  const lastWrite = lastPublicHeartbeatDbWrite.get(attempt.id) || 0;

  if (now.getTime() - lastWrite >= 60_000) {
    lastPublicHeartbeatDbWrite.set(attempt.id, now.getTime());
    prisma.attemptEvent.create({
      data: {
        attemptId: attempt.id,
        type: 'HEARTBEAT',
        clientTs: now,
        receivedAt: now,
        payload: (req.body && typeof req.body === 'object' && req.body.meta) ? req.body.meta : null,
      },
    }).catch(() => {});
  }

  const latestMessage = await prisma.intervention.findFirst({
    where: { attemptId: attempt.id, action: 'MESSAGE' },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    data: {
      status: attempt.status,
      deadlineAt: attempt.deadlineAt,
      extraMinutes: attempt.extraMinutes,
      remainingSec: remainingSec(attempt),
      isPaused: attempt.status === 'PAUSED',
      message: latestMessage
        ? {
            id: latestMessage.id,
            text: (latestMessage.params as any)?.message || latestMessage.reason,
            sentAt: latestMessage.createdAt,
          }
        : null,
    },
  });
};

const publicEventSchema = z.object({
  type: z.string().trim().min(1).max(64),
  count: z.number().int().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const recordPublicEvent = async (req: Request, res: Response) => {
  const attempt = await authorisedAttempt(req);
  const body = publicEventSchema.parse(req.body);
  const now = new Date();
  const eventType = body.type;

  await prisma.attemptEvent.create({
    data: {
      attemptId: attempt.id,
      type: eventType,
      clientTs: now,
      receivedAt: now,
      payload: (body.payload || (body.count ? { count: body.count } : null)) as Prisma.InputJsonValue,
    },
  }).catch(() => {});

  if (eventType === 'TAB_SWITCH') {
    const count = body.count ?? 1;
    const severity = count >= 2 ? 'HIGH' : 'WARNING';
    await prisma.flag.create({
      data: {
        attemptId: attempt.id,
        ruleKey: 'TAB_SWITCH',
        severity,
        details: { switchCount: count, clientTs: now.toISOString() },
      },
    }).catch(() => {});

    void publishRealtimeEvent({
      event: 'attempt.flagged',
      target: {
        rooms: [`sitting:${attempt.sittingId}`],
      },
      data: {
        sittingId: attempt.sittingId,
        attemptId: attempt.id,
        studentId: attempt.studentId,
        ruleKey: 'TAB_SWITCH',
        severity,
        details: { switchCount: count },
      },
    });
  }

  res.json({ data: { recorded: true } });
};

export const recordPublicFlag = async (req: Request, res: Response) => {
  const attempt = await authorisedAttempt(req);
  const type = String(req.body?.reason || req.body?.type || 'TAB_SWITCH');
  const count = typeof req.body?.count === 'number' ? req.body.count : 1;
  const now = new Date();

  await prisma.attemptEvent.create({
    data: {
      attemptId: attempt.id,
      type,
      clientTs: now,
      receivedAt: now,
      payload: { count, ...req.body },
    },
  }).catch(() => {});

  const severity = count >= 2 ? 'HIGH' : 'WARNING';
  await prisma.flag.create({
    data: {
      attemptId: attempt.id,
      ruleKey: type,
      severity,
      details: { switchCount: count, clientTs: now.toISOString() },
    },
  }).catch(() => {});

  void publishRealtimeEvent({
    event: 'attempt.flagged',
    target: {
      rooms: [`sitting:${attempt.sittingId}`],
    },
    data: {
      sittingId: attempt.sittingId,
      attemptId: attempt.id,
      studentId: attempt.studentId,
      ruleKey: type,
      severity,
      details: { switchCount: count },
    },
  });

  res.json({ data: { recorded: true } });
};
