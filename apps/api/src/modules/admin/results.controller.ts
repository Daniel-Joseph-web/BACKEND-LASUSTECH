import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { pageMeta, pageShape, sendCsv, toCsv, uuidParam } from '../../lib/http';
import { notifyUsers } from '../../lib/notify';
import { readSelectedPositions } from '../public-exams/scoring';

const listQuery = z.object({
  ...pageShape,
  search: z.string().trim().max(120).optional(),
  status: z.enum(['ALL', 'UNDER_REVIEW', 'PENDING', 'SUBMITTED', 'APPROVED', 'RELEASED']).default('ALL'),
});

interface SittingRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  examTitle: string;
  courseCode: string;
  courseTitle: string;
  batch: { id: string; status: string; submittedAt: Date | null; approvedAt: Date | null; releasedAt: Date | null } | null;
  scripts: number;
  flags: number;
  notReleased: number;
}

const present = (s: SittingRow) => {
  const status = s.batch?.status ?? 'PENDING';
  return {
    id: s.id,
    batchId: s.batch?.id ?? null,
    courseCode: s.courseCode,
    courseTitle: s.courseTitle,
    examTitle: s.examTitle,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    sittingStatus: s.status,
    scripts: s.scripts,
    flags: s.flags,
    status,
    submittedAt: s.batch?.submittedAt ?? null,
    approvedAt: s.batch?.approvedAt ?? null,
    releasedAt: s.batch?.releasedAt ?? null,
  };
};

export const listResults = async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query);
  const where: Prisma.SittingWhereInput = {
    attempts: { some: { results: { some: { isCurrent: true } } } },
  };

  if (q.search) {
    const search = q.search;
    where.OR = [
      { exam: { title: { contains: search, mode: 'insensitive' } } },
      { exam: { course: { code: { contains: search, mode: 'insensitive' } } } },
      { exam: { course: { title: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  const sittings = await prisma.sitting.findMany({
    where,
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      exam: {
        select: {
          title: true,
          course: { select: { code: true, title: true } },
        },
      },
      batches: {
        select: {
          id: true,
          status: true,
          submittedAt: true,
          approvedAt: true,
          releasedAt: true,
        },
      },
    },
    orderBy: { startsAt: 'desc' },
  });

  const ids = sittings.map((s) => s.id);
  const statsRows = ids.length
    ? await prisma.$queryRaw<{ sitting_id: string; scripts: number; flags: number; not_released: number }[]>`
        SELECT s.id AS sitting_id,
               COUNT(DISTINCT r.id)::int AS scripts,
               COUNT(DISTINCT f.id)::int AS flags,
               COUNT(DISTINCT CASE WHEN r.status <> 'RELEASED' THEN r.id END)::int AS not_released
          FROM sittings s
          LEFT JOIN attempts a ON a.sitting_id = s.id
          LEFT JOIN results r ON r.attempt_id = a.id AND r.is_current = true
          LEFT JOIN flags f ON f.attempt_id = a.id AND f.reviewed_at IS NULL
         WHERE s.id::text IN (${Prisma.join(ids)})
         GROUP BY s.id
      `
    : [];
  const stats = new Map(statsRows.map((r) => [r.sitting_id, r]));

  const rows: SittingRow[] = sittings.map((s) => {
    const stat = stats.get(s.id);
    return {
      id: s.id,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      status: s.status,
      examTitle: s.exam.title,
      courseCode: s.exam.course?.code ?? null,
      courseTitle: s.exam.course?.title ?? null,
      batch: s.batches[0] ?? null,
      scripts: stat?.scripts ?? 0,
      flags: stat?.flags ?? 0,
      notReleased: stat?.not_released ?? 0,
    };
  });

  const filtered =
    q.status === 'ALL'
      ? rows
      : rows.filter((r) => {
          const status = present(r).status;
          return q.status === 'UNDER_REVIEW' ? r.flags > 0 : status === q.status;
        });

  const start = (q.page - 1) * q.pageSize;
  const pageRows = filtered.slice(start, start + q.pageSize);

  res.json({
    data: pageRows.map(present),
    meta: {
      ...pageMeta(q.page, q.pageSize, filtered.length),
      counts: {
        pending: rows.filter((r) => present(r).status === 'PENDING').length,
        approved: rows.filter((r) => present(r).status === 'APPROVED').length,
        released: rows.filter((r) => present(r).status === 'RELEASED').length,
        flagged: rows.filter((r) => r.flags > 0).length,
      },
    },
  });
};

async function loadSitting(sittingId: string) {
  const sitting = await prisma.sitting.findUnique({
    where: { id: sittingId },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      exam: { select: { title: true, course: { select: { code: true, title: true } } } },
    },
  });
  if (!sitting) throw Errors.notFound('Sitting');
  const scripts = await prisma.result.count({
    where: { isCurrent: true, attempt: { sittingId } },
  });
  if (scripts === 0) {
    throw Errors.badRequest('NO_RESULTS', 'No scored scripts exist for this sitting yet.');
  }
  return { sitting, scripts };
}

export const approveResults = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const actor = actorFrom(req, res);
  await loadSitting(sittingId);

  const batch = await prisma.$transaction(async (tx) => {
    const existing = await tx.resultBatch.findUnique({ where: { sittingId } });
    if (existing?.status === 'RELEASED') {
      throw Errors.conflict(
        'ALREADY_RELEASED',
        'These results are already released. Resolve an appeal to amend a score.',
      );
    }

    const saved = await tx.resultBatch.upsert({
      where: { sittingId },
      create: {
        sittingId,
        status: 'APPROVED',
        approvedBy: actor.actorId,
        approvedAt: new Date(),
      },
      update: {
        status: 'APPROVED',
        approvedBy: actor.actorId,
        approvedAt: new Date(),
      },
    });

    await tx.result.updateMany({
      where: { isCurrent: true, attempt: { sittingId }, status: { not: 'RELEASED' } },
      data: { status: 'APPROVED' },
    });

    await writeAudit(tx, actor, {
      action: 'result.approve',
      targetType: 'Sitting',
      targetId: sittingId,
      before: existing ? { status: existing.status } : null,
      after: { status: saved.status },
    });
    return saved;
  });

  res.json({ data: { sittingId, status: batch.status, approvedAt: batch.approvedAt } });
};

export const releaseResults = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const actor = actorFrom(req, res);
  const { sitting } = await loadSitting(sittingId);

  // Guard: results can ONLY be released after the exam has officially concluded.
  const now = new Date();
  if (now < sitting.endsAt && sitting.status !== 'CLOSED') {
    throw Errors.badRequest(
      'EXAM_NOT_CONCLUDED',
      `Results cannot be released while the examination is still active or ongoing. The exam is scheduled until ${sitting.endsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Results can only be released after the exam has concluded.`,
    );
  }

  const activeAttempts = await prisma.attempt.count({
    where: { sittingId, status: 'IN_PROGRESS' },
  });
  if (activeAttempts > 0 && now < sitting.endsAt) {
    throw Errors.badRequest(
      'CANDIDATES_ACTIVE',
      `There are currently ${activeAttempts} candidate(s) still writing this examination. Results cannot be released until all candidate sittings have concluded.`,
    );
  }

  const batch = await prisma.$transaction(async (tx) => {
    const existing = await tx.resultBatch.findUnique({ where: { sittingId } });
    const current = existing?.status ?? 'PENDING';
    if (current === 'RELEASED') {
      throw Errors.conflict('ALREADY_RELEASED', 'These results are already released.');
    }
    if (current !== 'APPROVED') {
      throw Errors.conflict(
        'NOT_APPROVED',
        'Approve these results before releasing them to student portals.',
        { status: current },
      );
    }

    const saved = await tx.resultBatch.update({
      where: { sittingId },
      data: {
        status: 'RELEASED',
        releasedBy: actor.actorId,
        releasedAt: new Date(),
      },
    });

    const updated = await tx.result.updateMany({
      where: { isCurrent: true, attempt: { sittingId } },
      data: { status: 'RELEASED' },
    });

    await writeAudit(tx, actor, {
      action: 'result.release',
      targetType: 'Sitting',
      targetId: sittingId,
      before: { status: 'APPROVED' },
      after: { status: 'RELEASED', scripts: updated.count },
    });

    // One notification per candidate, not per script: an amended result leaves
    // superseded rows behind, and those students should not be told twice.
    const students = await tx.attempt.findMany({
      where: { sittingId, results: { some: { isCurrent: true } } },
      select: { studentId: true },
      distinct: ['studentId'],
    });
    await notifyUsers(
      tx,
      students.map((s) => s.studentId),
      {
        type: 'RESULT_RELEASED',
        title: 'Results released',
        body: `Your result for ${sitting.exam.course?.code ?? sitting.exam.title} — ${sitting.exam.title} is now available on your portal.`,
        meta: { sittingId, href: '/student/results' },
      },
    );
    return saved;
  });

  res.json({ data: { sittingId, status: batch.status, releasedAt: batch.releasedAt } });
};

/** Marks every open proctoring flag in the sitting as reviewed. */
export const resolveResultFlags = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const actor = actorFrom(req, res);

  const sitting = await prisma.sitting.findUnique({ where: { id: sittingId }, select: { id: true } });
  if (!sitting) throw Errors.notFound('Sitting');

  const result = await prisma.$transaction(async (tx) => {
    const flags = await tx.flag.updateMany({
      where: { reviewedAt: null, attempt: { sittingId } },
      data: { reviewedAt: new Date(), reviewedBy: actor.actorId },
    });
    await writeAudit(tx, actor, {
      action: 'result.resolve_flags',
      targetType: 'Sitting',
      targetId: sittingId,
      after: { resolved: flags.count },
    });
    return flags;
  });

  res.json({ data: { sittingId, resolved: result.count } });
};

/** Detailed score breakdown for all candidates in a sitting. */
export const getSittingResults = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);

  const sitting = await prisma.sitting.findUnique({
    where: { id: sittingId },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      status: true,
      exam: {
        select: {
          title: true,
          course: { select: { code: true, title: true } },
          subject: { select: { name: true } },
        },
      },
    },
  });

  if (!sitting) throw Errors.notFound('Sitting');

  const results = await prisma.result.findMany({
    where: { isCurrent: true, attempt: { sittingId } },
    include: {
      attempt: {
        select: {
          id: true,
          startedAt: true,
          submittedAt: true,
          ipStart: true,
          student: {
            select: {
              id: true,
              names: true,
              matricNo: true,
              email: true,
            },
          },
          flags: {
            select: {
              id: true,
              ruleKey: true,
              severity: true,
              reviewedAt: true,
            },
          },
        },
      },
    },
    orderBy: [{ percent: 'desc' }, { attempt: { student: { matricNo: 'asc' } } }],
  });

  const scores = results.map((r) => Number(r.percent));
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const passed = results.filter((r) => Number(r.percent) >= 40).length;
  const failed = results.filter((r) => Number(r.percent) < 40).length;
  const totalFlags = results.reduce((acc, r) => acc + r.attempt.flags.length, 0);

  res.json({
    data: {
      sitting: {
        id: sitting.id,
        examTitle: sitting.exam.title,
        courseCode: sitting.exam.course?.code ?? sitting.exam.subject?.name ?? 'EXAM',
        courseTitle: sitting.exam.course?.title ?? sitting.exam.title,
        startsAt: sitting.startsAt,
        endsAt: sitting.endsAt,
        status: sitting.status,
      },
      stats: {
        total: results.length,
        average: avg,
        passed,
        failed,
        flags: totalFlags,
      },
      candidates: results.map((r) => ({
        id: r.id,
        attemptId: r.attempt.id,
        studentId: r.attempt.student.id,
        studentName: r.attempt.student.names,
        matricNo: r.attempt.student.matricNo ?? 'N/A',
        rawScore: Number(r.rawScore),
        maxScore: Number(r.maxScore),
        percent: Number(r.percent),
        grade: r.grade,
        status: r.status,
        flagsCount: r.attempt.flags.length,
        flags: r.attempt.flags.map((f) => ({
          id: f.id,
          flagType: f.ruleKey,
          severity: f.severity,
        })),
        timeSpent:
          r.attempt.startedAt && r.attempt.submittedAt
            ? `${Math.round((r.attempt.submittedAt.getTime() - r.attempt.startedAt.getTime()) / 60000)}m`
            : 'N/A',
        startedAt: r.attempt.startedAt,
        submittedAt: r.attempt.submittedAt,
      })),
    },
  });
};

/** Exports sitting scores as a senate-ready CSV broadsheet. */
export const exportSittingResultsCsv = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);

  const sitting = await prisma.sitting.findUnique({
    where: { id: sittingId },
    select: {
      id: true,
      exam: {
        select: {
          title: true,
          course: { select: { code: true } },
          subject: { select: { name: true } },
        },
      },
    },
  });

  if (!sitting) throw Errors.notFound('Sitting');

  const results = await prisma.result.findMany({
    where: { isCurrent: true, attempt: { sittingId } },
    include: {
      attempt: {
        select: {
          startedAt: true,
          submittedAt: true,
          student: { select: { names: true, matricNo: true } },
          flags: { select: { id: true } },
        },
      },
    },
    orderBy: [{ attempt: { student: { matricNo: 'asc' } } }],
  });

  const code = sitting.exam.course?.code ?? sitting.exam.subject?.name ?? 'RESULTS';
  const headers = [
    'S/N',
    'Matric Number',
    'Full Name',
    'Raw Score',
    'Max Score',
    'Percentage (%)',
    'Grade',
    'Status',
    'Proctor Flags',
    'Started At',
    'Submitted At',
  ];

  const rows = results.map((r, i) => [
    String(i + 1),
    r.attempt.student.matricNo ?? 'N/A',
    r.attempt.student.names,
    String(r.rawScore),
    String(r.maxScore),
    String(r.percent),
    r.grade,
    r.status,
    String(r.attempt.flags.length),
    r.attempt.startedAt?.toISOString() ?? '',
    r.attempt.submittedAt?.toISOString() ?? '',
  ]);

  const filename = `${code.replace(/[^a-z0-9_-]/gi, '_')}_Broadsheet_${new Date().toISOString().slice(0, 10)}.csv`;
  sendCsv(res, filename, toCsv(headers, rows));
};

const GRADE_FALLBACK: { grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'; min: number }[] = [
  { grade: 'A', min: 70 },
  { grade: 'B', min: 60 },
  { grade: 'C', min: 50 },
  { grade: 'D', min: 45 },
  { grade: 'E', min: 40 },
  { grade: 'F', min: 0 },
];

export async function buildAttemptScriptPayload(attemptId: string) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      student: {
        select: {
          id: true,
          names: true,
          matricNo: true,
          email: true,
          department: { select: { name: true, code: true } },
        },
      },
      sitting: {
        include: {
          exam: {
            select: {
              id: true,
              title: true,
              passMark: true,
              course: { select: { id: true, code: true, title: true } },
              subject: { select: { id: true, name: true } },
            },
          },
        },
      },
      results: {
        where: { isCurrent: true },
        include: {
          scoreChanges: {
            orderBy: { createdAt: 'desc' },
            include: { author: { select: { names: true } } },
          },
        },
      },
      questions: {
        orderBy: { position: 'asc' },
        include: {
          questionVersion: {
            include: {
              topic: { select: { name: true } },
              options: { orderBy: { position: 'asc' } },
            },
          },
        },
      },
      answers: true,
      flags: {
        select: {
          id: true,
          ruleKey: true,
          severity: true,
          createdAt: true,
        },
      },
    },
  });

  if (!attempt) throw Errors.notFound('Attempt');

  const answersByQuestion = new Map(attempt.answers.map((a) => [a.questionVersionId, a]));
  const currentResult = attempt.results[0] ?? null;

  const questionsBreakdown = attempt.questions.map((q, idx) => {
    const version = q.questionVersion;
    const answer = answersByQuestion.get(q.questionVersionId);
    const selectedPositions = new Set(readSelectedPositions(answer?.value));
    const correctPositions = new Set(
      version.options.filter((o) => o.isCorrect).map((o) => o.position),
    );

    const isCorrect =
      correctPositions.size > 0 &&
      selectedPositions.size === correctPositions.size &&
      [...selectedPositions].every((pos) => correctPositions.has(pos));

    const weightedMarks = Number(q.weightedMarks);
    const marksAwarded = isCorrect ? weightedMarks : 0;

    const options = version.options.map((opt) => {
      const rawBody = opt.body as any;
      const optText =
        typeof rawBody === 'string'
          ? rawBody
          : (rawBody?.text ?? rawBody?.html ?? rawBody?.label ?? '');
      return {
        id: opt.id,
        position: opt.position,
        text: optText,
        isCorrect: opt.isCorrect,
        isSelected: selectedPositions.has(opt.position),
      };
    });

    const rawStem = version.stem as any;
    const stemText =
      typeof rawStem === 'string'
        ? rawStem
        : (rawStem?.text ?? rawStem?.html ?? rawStem?.markdown ?? '');

    return {
      questionNo: idx + 1,
      questionId: version.questionId,
      versionId: version.id,
      stem: stemText,
      topicName: version.topic?.name ?? 'General',
      difficulty: version.difficulty,
      weightedMarks,
      marksAwarded,
      isCorrect,
      isAnswered: selectedPositions.size > 0,
      explanation: version.explanation,
      options,
    };
  });

  const durationMin =
    attempt.startedAt && attempt.submittedAt
      ? Math.round((attempt.submittedAt.getTime() - attempt.startedAt.getTime()) / 60000)
      : null;

  return {
    attemptId: attempt.id,
    student: {
      id: attempt.student.id,
      names: attempt.student.names,
      matricNo: attempt.student.matricNo ?? 'N/A',
      email: attempt.student.email,
      department: attempt.student.department?.name ?? '—',
    },
    exam: {
      id: attempt.sitting.exam.id,
      title: attempt.sitting.exam.title,
      code: attempt.sitting.exam.course?.code ?? attempt.sitting.exam.subject?.name ?? 'EXAM',
      courseTitle: attempt.sitting.exam.course?.title ?? attempt.sitting.exam.title,
    },
    attempt: {
      status: attempt.status,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      durationMin,
      ipStart: attempt.ipStart,
      deviceHash: attempt.deviceHash,
    },
    result: currentResult
      ? {
          id: currentResult.id,
          scoreVersion: currentResult.scoreVersion,
          rawScore: Number(currentResult.rawScore),
          maxScore: Number(currentResult.maxScore),
          percent: Number(currentResult.percent),
          grade: currentResult.grade,
          status: currentResult.status,
          scoredAt: currentResult.scoredAt,
          scoreChanges: currentResult.scoreChanges.map((sc) => ({
            id: sc.id,
            oldScore: Number(sc.oldScore),
            newScore: Number(sc.newScore),
            reason: sc.reason,
            changedBy: sc.author.names,
            changedAt: sc.createdAt,
          })),
        }
      : null,
    flags: attempt.flags.map((f) => ({
      id: f.id,
      ruleKey: f.ruleKey,
      severity: f.severity,
      createdAt: f.createdAt,
    })),
    questions: questionsBreakdown,
  };
}

const overrideScoreSchema = z.object({
  newRawScore: z.number().min(0, 'Score cannot be negative.'),
  reason: z.string().trim().min(5, 'A clear reason for score adjustment is required (at least 5 characters).').max(1000),
});

/**
 * Score Adjustment / Override: ADMIN ONLY.
 * Modifies an existing result in an audited transaction, saving previous score
 * into score_changes and writing to audit_logs.
 */
export const overrideScore = async (req: Request, res: Response) => {
  const resultId = uuidParam(req);
  const actor = actorFrom(req, res);
  const body = overrideScoreSchema.parse(req.body);

  const currentResult = await prisma.result.findUnique({
    where: { id: resultId },
    include: {
      attempt: {
        include: {
          sitting: {
            include: {
              exam: { select: { title: true, course: { select: { code: true } } } },
            },
          },
          student: { select: { names: true, matricNo: true } },
        },
      },
    },
  });

  if (!currentResult) throw Errors.notFound('Result');
  if (!currentResult.isCurrent) {
    throw Errors.conflict('STALE_RESULT', 'This result has already been superseded by a newer score version.');
  }

  const maxScore = Number(currentResult.maxScore);
  if (body.newRawScore > maxScore) {
    throw Errors.badRequest('SCORE_EXCEEDS_MAX', `New score (${body.newRawScore}) cannot exceed the exam max score (${maxScore}).`);
  }

  const percent = maxScore > 0 ? Math.round((body.newRawScore / maxScore) * 10000) / 100 : 0;
  const bands = await prisma.gradeBand.findMany({ orderBy: { minPercent: 'desc' } });
  const grade =
    bands.find((b) => percent >= Number(b.minPercent))?.grade ??
    GRADE_FALLBACK.find((b) => percent >= b.min)?.grade ?? 'F';

  const updatedResult = await prisma.$transaction(async (tx) => {
    // 1. Mark previous result inactive
    await tx.result.update({
      where: { id: currentResult.id },
      data: { isCurrent: false },
    });

    // 2. Insert new AMENDED result version
    const nextResult = await tx.result.create({
      data: {
        attemptId: currentResult.attemptId,
        scoreVersion: currentResult.scoreVersion + 1,
        rawScore: new Prisma.Decimal(body.newRawScore),
        maxScore: currentResult.maxScore,
        percent: new Prisma.Decimal(percent),
        grade,
        status: 'AMENDED',
        isCurrent: true,
      },
    });

    // 3. Insert into score_changes audit table
    await tx.scoreChange.create({
      data: {
        resultId: currentResult.id,
        oldScore: currentResult.rawScore,
        newScore: new Prisma.Decimal(body.newRawScore),
        reason: body.reason,
        createdBy: actor.actorId,
        approvedBy: actor.actorId,
      },
    });

    // 4. Log institutional audit entry
    await writeAudit(tx, actor, {
      action: 'result.override_score',
      targetType: 'Result',
      targetId: currentResult.id,
      before: {
        rawScore: Number(currentResult.rawScore),
        percent: Number(currentResult.percent),
        grade: currentResult.grade,
      },
      after: {
        newResultId: nextResult.id,
        rawScore: body.newRawScore,
        percent,
        grade,
        reason: body.reason,
      },
    });

    // 5. If batch was already approved or released, reset to PENDING so senate/exam office can verify
    await tx.resultBatch.updateMany({
      where: {
        sitting: { attempts: { some: { id: currentResult.attemptId } } },
        status: { in: ['APPROVED', 'RELEASED'] },
      },
      data: { status: 'PENDING', releasedAt: null, releasedBy: null },
    });

    return nextResult;
  });

  res.json({
    data: {
      id: updatedResult.id,
      attemptId: updatedResult.attemptId,
      rawScore: Number(updatedResult.rawScore),
      maxScore: Number(updatedResult.maxScore),
      percent: Number(updatedResult.percent),
      grade: updatedResult.grade,
      status: updatedResult.status,
      message: `Score updated to ${updatedResult.rawScore} (${updatedResult.percent}%, Grade ${updatedResult.grade}). Audit log and score change record created.`,
    },
  });
};

export const getAttemptScript = async (req: Request, res: Response) => {
  const attemptId = req.params.attemptId ? uuidParam(req, 'attemptId') : uuidParam(req);
  const payload = await buildAttemptScriptPayload(attemptId);
  res.json({ data: payload });
};


