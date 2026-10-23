import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { LAGOS_OFFSET_MS, fmtDay, sendCsv, toCsv, todayLagos, uuidParam } from '../../lib/http';
import { closeExpiredSittings } from '../student/student.service';
import { scoreAttempt } from '../public-exams/scoring';
import { publishRealtimeEvent } from '../../lib/realtime';

const OFFLINE_AFTER_SEC = 60;

const dayRange = () => {
  const day = todayLagos();
  const start = new Date(day.getTime() - LAGOS_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { day, start, end };
};

const liveInclude = {
  exam: {
    select: {
      id: true,
      title: true,
      course: { select: { id: true, code: true, title: true } },
    },
  },
  venueRef: { select: { id: true, code: true, name: true, capacity: true } },
  _count: { select: { students: true, invigilators: true } },
} satisfies Prisma.SittingInclude;

type LiveSitting = Prisma.SittingGetPayload<{ include: typeof liveInclude }>;

interface SittingStats {
  active: number;
  submitted: number;
  flagged: number;
  offline: number;
}

async function statsFor(sittingIds: string[]) {
  if (!sittingIds.length) return new Map<string, SittingStats>();

  const [attemptRows, flagRows, offlineRows] = await Promise.all([
    prisma.attempt.groupBy({
      by: ['sittingId', 'status'],
      where: { sittingId: { in: sittingIds } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<{ sitting_id: string; flagged: number }[]>`
      SELECT a.sitting_id, COUNT(DISTINCT f.attempt_id)::int AS flagged
        FROM flags f
        JOIN attempts a ON a.id = f.attempt_id
       WHERE f.reviewed_at IS NULL AND a.sitting_id::text IN (${Prisma.join(sittingIds)})
       GROUP BY a.sitting_id
    `,
    prisma.$queryRaw<{ sitting_id: string; offline: number }[]>`
      SELECT a.sitting_id,
             COUNT(*)::int AS offline
        FROM attempts a
        LEFT JOIN LATERAL (
          SELECT e.received_at
            FROM attempt_events e
           WHERE e.attempt_id = a.id
           ORDER BY e.received_at DESC
           LIMIT 1
        ) last_seen ON true
       WHERE a.status = 'IN_PROGRESS'
         AND a.sitting_id::text IN (${Prisma.join(sittingIds)})
         AND (last_seen.received_at IS NULL OR last_seen.received_at < now() - interval '60 seconds')
       GROUP BY a.sitting_id
    `,
  ]);

  const map = new Map<string, SittingStats>(
    sittingIds.map((id) => [id, { active: 0, submitted: 0, flagged: 0, offline: 0 }]),
  );
  for (const row of attemptRows) {
    const stat = map.get(row.sittingId);
    if (!stat) continue;
    if (row.status === 'IN_PROGRESS') stat.active += row._count._all;
    if (row.status === 'PAUSED') stat.active += row._count._all;
    if (row.status === 'SUBMITTED' || row.status === 'AUTO_SUBMITTED') stat.submitted += row._count._all;
  }
  for (const row of flagRows) {
    const stat = map.get(row.sitting_id);
    if (stat) stat.flagged = row.flagged;
  }
  for (const row of offlineRows) {
    const stat = map.get(row.sitting_id);
    if (stat) stat.offline = row.offline;
  }
  return map;
}

const presentLive = (s: LiveSitting, stats: SittingStats) => ({
  id: s.id,
  examId: s.examId,
  examTitle: s.exam.title,
  courseCode: s.exam.course?.code ?? null,
  courseTitle: s.exam.course?.title ?? null,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  durationMin: s.durationMin,
  venue: s.venue,
  venueId: s.venueId,
  status: s.status,
  registered: s._count.students,
  terminals: s.venueRef?.capacity ?? s._count.students,
  invigilators: s._count.invigilators,
  active: stats.active,
  submitted: stats.submitted,
  flagged: stats.flagged,
  offline: stats.offline,
});

/** Today's sittings (Africa/Lagos) with their live counters. */
export const listLive = async (req: Request, res: Response) => {
  await closeExpiredSittings();
  const q = z
    .object({
      search: z.string().trim().max(120).optional(),
      status: z.enum(['ALL', 'SCHEDULED', 'OPEN', 'CLOSED']).default('ALL'),
    })
    .parse(req.query);

  await closeExpiredSittings();

  const { day, start, end } = dayRange();
  const where: Prisma.SittingWhereInput = {
    startsAt: { gte: start, lt: end },
    status: q.status === 'ALL' ? { not: 'CANCELLED' } : q.status,
  };
  if (q.search) {
    const search = q.search;
    where.OR = [
      { venue: { contains: search, mode: 'insensitive' } },
      { exam: { title: { contains: search, mode: 'insensitive' } } },
      { exam: { course: { code: { contains: search, mode: 'insensitive' } } } },
      { exam: { course: { title: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  const sittings = await prisma.sitting.findMany({
    where,
    include: liveInclude,
    orderBy: { startsAt: 'asc' },
  });
  const stats = await statsFor(sittings.map((s) => s.id));
  const data = sittings.map((s) =>
    presentLive(s, stats.get(s.id) ?? { active: 0, submitted: 0, flagged: 0, offline: 0 }),
  );

  res.json({
    data,
    meta: {
      today: fmtDay(day),
      counts: {
        sessions: data.length,
        active: data.reduce((n, s) => n + s.active, 0),
        flagged: data.reduce((n, s) => n + s.flagged, 0),
        offline: data.reduce((n, s) => n + s.offline, 0),
      },
    },
  });
};

const detailInclude = {
  exam: {
    select: {
      id: true,
      title: true,
      instructions: true,
      course: { select: { id: true, code: true, title: true } },
    },
  },
  venueRef: { select: { id: true, code: true, name: true, capacity: true } },
  invigilators: { select: { user: { select: { id: true, names: true, staffId: true } } } },
  students: {
    select: {
      studentId: true,
      seatLabel: true,
      extraMinutes: true,
      student: { select: { id: true, names: true, matricNo: true } },
    },
  },
  incidents: {
    where: { status: { not: 'RESOLVED' } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  },
} satisfies Prisma.SittingInclude;

type StudentRow = {
  attemptId: string | null;
  studentId: string;
  name: string;
  matricNo: string | null;
  seat: string | null;
  status: string;
  progress: number;
  answered: number;
  questionCount: number;
  flags: number;
  recentFlags: { id: string; ruleKey: string; severity: string; createdAt: Date; details: unknown }[];
  extraMinutes: number;
  startedAt: Date | null;
  deadlineAt: Date | null;
  submittedAt: Date | null;
  pausedAt: Date | null;
  lastSeenAt: Date | null;
  offlineSeconds: number | null;
  isPaused: boolean;
  state: string;
};

export const getLiveSitting = async (req: Request, res: Response) => {
  await closeExpiredSittings();
  const id = uuidParam(req);
  const sitting = await prisma.sitting.findUnique({ where: { id }, include: detailInclude });
  if (!sitting) throw Errors.notFound('Sitting');

  const attempts = await prisma.attempt.findMany({
    where: { sittingId: id },
    orderBy: { attemptNo: 'desc' },
    include: {
      flags: {
        where: { reviewedAt: null },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  const attemptIds = attempts.map((a) => a.id);

  const [answerRows, lastSeenRows, interventions] = await Promise.all([
    attemptIds.length
      ? prisma.answer.groupBy({
          by: ['attemptId'],
          where: { attemptId: { in: attemptIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    attemptIds.length
      ? prisma.$queryRaw<
          { attempt_id: string; last_seen: Date | null; last_type: string | null }[]
        >`
          SELECT a.id AS attempt_id,
                 le.received_at AS last_seen,
                 le.type AS last_type
            FROM attempts a
            LEFT JOIN LATERAL (
              SELECT e.received_at, e.type
                FROM attempt_events e
               WHERE e.attempt_id = a.id
               ORDER BY e.received_at DESC
               LIMIT 1
            ) le ON true
           WHERE a.id::text IN (${Prisma.join(attemptIds)})
        `
      : Promise.resolve([]),
    prisma.intervention.findMany({
      where: { attempt: { sittingId: id } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        actor: { select: { id: true, names: true } },
        attempt: { select: { id: true, student: { select: { names: true } } } },
      },
    }),
  ]);

  const answered = new Map(answerRows.map((r) => [r.attemptId, r._count._all]));
  const lastSeen = new Map(lastSeenRows.map((r) => [r.attempt_id, r]));
  const now = Date.now();

  const attemptsByStudent = new Map<string, (typeof attempts)[number]>();
  for (const a of attempts) if (!attemptsByStudent.has(a.studentId)) attemptsByStudent.set(a.studentId, a);

  const students: StudentRow[] = [];
  const seen = new Set<string>();
  for (const row of sitting.students) {
    seen.add(row.studentId);
    const attempt = attemptsByStudent.get(row.studentId);
    students.push(toStudent(row.student, row.seatLabel, row.extraMinutes, attempt, answered, lastSeen, now));
  }
  for (const attempt of attemptsByStudent.values()) {
    if (seen.has(attempt.studentId)) continue;
    const user = await prisma.user.findUnique({
      where: { id: attempt.studentId },
      select: { id: true, names: true, matricNo: true },
    });
    if (user) students.push(toStudent(user, null, 0, attempt, answered, lastSeen, now));
  }

  res.json({
    data: {
      sitting: {
        id: sitting.id,
        examId: sitting.examId,
        examTitle: sitting.exam.title,
        courseCode: sitting.exam.course?.code ?? null,
        courseTitle: sitting.exam.course?.title ?? null,
        startsAt: sitting.startsAt,
        endsAt: sitting.endsAt,
        durationMin: sitting.durationMin,
        venue: sitting.venue,
        venueId: sitting.venueId,
        venueCapacity: sitting.venueRef?.capacity ?? null,
        status: sitting.status,
        requireWebcam: sitting.requireWebcam,
        requireSeb: sitting.requireSeb,
      },
      invigilators: sitting.invigilators.map((i) => i.user),
      students,
      incidents: sitting.incidents,
      interventions: interventions.map((i) => ({
        id: i.id,
        attemptId: i.attemptId,
        studentName: i.attempt.student.names,
        action: i.action,
        params: i.params,
        reason: i.reason,
        actorName: i.actor.names,
        actorId: i.actorId,
        createdAt: i.createdAt,
      })),
    },
  });
};

type AttemptForRow = Prisma.AttemptGetPayload<{ include: { flags: true } }>;

function toStudent(
  user: { id: string; names: string; matricNo: string | null },
  seat: string | null,
  extraMinutes: number,
  attempt: AttemptForRow | undefined,
  answered: Map<string, number>,
  lastSeen: Map<string, { last_seen: Date | null; last_type: string | null }>,
  now: number,
): StudentRow {
  if (!attempt) {
    return {
      attemptId: null,
      studentId: user.id,
      name: user.names,
      matricNo: user.matricNo,
      seat,
      status: 'NOT_STARTED',
      progress: 0,
      answered: 0,
      questionCount: 0,
      flags: 0,
      recentFlags: [],
      extraMinutes,
      startedAt: null,
      deadlineAt: null,
      submittedAt: null,
      pausedAt: null,
      lastSeenAt: null,
      offlineSeconds: null,
      isPaused: false,
      state: 'NOT_STARTED',
    };
  }

  const answeredCount = answered.get(attempt.id) ?? 0;
  const questionCount = attempt.questionCount;
  const seen = lastSeen.get(attempt.id);
  const lastSeenAt = seen?.last_seen ?? null;
  const offlineSeconds = lastSeenAt ? Math.max(0, Math.round((now - lastSeenAt.getTime()) / 1000)) : null;

  let state: string;
  if (attempt.status === 'IN_PROGRESS') {
    state = offlineSeconds === null || offlineSeconds > OFFLINE_AFTER_SEC ? 'OFFLINE' : 'ACTIVE';
  } else if (attempt.status === 'PAUSED') {
    state = 'PAUSED';
  } else {
    state = attempt.status;
  }

  return {
    attemptId: attempt.id,
    studentId: user.id,
    name: user.names,
    matricNo: user.matricNo,
    seat,
    status: attempt.status,
    progress: questionCount ? Math.round((answeredCount / questionCount) * 100) : 0,
    answered: answeredCount,
    questionCount,
    flags: attempt.flags.length,
    recentFlags: attempt.flags.map((f) => ({
      id: f.id,
      ruleKey: f.ruleKey,
      severity: f.severity,
      createdAt: f.createdAt,
      details: f.details,
    })),
    extraMinutes: attempt.extraMinutes,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    submittedAt: attempt.submittedAt,
    pausedAt: attempt.pausedAt,
    lastSeenAt,
    offlineSeconds,
    isPaused: attempt.status === 'PAUSED',
    state,
  };
}

const interveneSchema = z.object({
  attemptId: z.uuid(),
  action: z.enum(['PAUSE', 'RESUME', 'EXTEND', 'RESET_SESSION', 'END', 'MESSAGE']),
  minutes: z.number().int().min(1).max(120).optional(),
  message: z.string().trim().max(500).optional(),
  reason: z.string().trim().max(500).optional(),
});

const ACTION_REASON: Record<string, string> = {
  PAUSE: 'Paused by invigilator',
  RESUME: 'Resumed by invigilator',
  EXTEND: 'Extra time granted by invigilator',
  RESET_SESSION: 'Session released for re-login by invigilator',
  END: 'Script ended by invigilator',
  MESSAGE: 'Message sent by invigilator',
};

export const intervene = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const body = interveneSchema.parse(req.body);
  const actor = actorFrom(req, res);

  if (body.action === 'EXTEND' && body.minutes === undefined) {
    throw Errors.badRequest('MINUTES_REQUIRED', 'Enter how many extra minutes to grant.');
  }
  if (body.action === 'MESSAGE' && !body.message) {
    throw Errors.badRequest('MESSAGE_REQUIRED', 'Enter the message to send.');
  }

  const result = await prisma.$transaction(async (tx) => {
    const attempt = await tx.attempt.findUnique({ where: { id: body.attemptId } });
    if (!attempt || attempt.sittingId !== sittingId) throw Errors.notFound('Attempt');

    const now = new Date();
    const reason = body.reason?.trim() || ACTION_REASON[body.action];
    let data: Prisma.AttemptUpdateInput = {};
    let params: Prisma.InputJsonValue = {};

    switch (body.action) {
      case 'PAUSE': {
        if (attempt.status !== 'IN_PROGRESS') {
          throw Errors.conflict('NOT_RUNNING', 'Only an in-progress attempt can be paused.');
        }
        data = { status: 'PAUSED', pausedAt: now };
        break;
      }
      case 'RESUME': {
        if (attempt.status !== 'PAUSED') {
          throw Errors.conflict('NOT_PAUSED', 'This attempt is not paused.');
        }
        const pausedSec = attempt.pausedAt
          ? Math.max(0, Math.round((now.getTime() - attempt.pausedAt.getTime()) / 1000))
          : 0;
        data = {
          status: 'IN_PROGRESS',
          pausedAt: null,
          pausedTotalSec: attempt.pausedTotalSec + pausedSec,
        };
        params = { pausedSec };
        break;
      }
      case 'EXTEND': {
        if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
          throw Errors.conflict('NOT_RUNNING', 'Extra time can only be given to a running attempt.');
        }
        const minutes = body.minutes as number;
        data = {
          extraMinutes: attempt.extraMinutes + minutes,
          ...(attempt.deadlineAt
            ? { deadlineAt: new Date(attempt.deadlineAt.getTime() + minutes * 60_000) }
            : {}),
        };
        params = { minutes };
        break;
      }
      case 'RESET_SESSION': {
        // Detach the attempt from its auth session and phone binding; the
        // student signs in again before the launcher will resume the paper.
        data = { authSession: { disconnect: true }, deviceHash: null };
        break;
      }
      case 'END': {
        if (!['IN_PROGRESS', 'PAUSED'].includes(attempt.status)) {
          throw Errors.conflict('NOT_RUNNING', 'Only a running attempt can be ended.');
        }
        data = {
          status: 'TERMINATED',
          endedReason: 'INVIGILATOR_END',
          submittedAt: now,
          pausedAt: null,
        };
        await scoreAttempt(tx, attempt.id, {
          auto: true,
          endedReason: 'AUTO_SUBMIT',
        }).catch(() => {});
        break;
      }
      case 'MESSAGE': {
        params = { message: body.message!.trim() };
        break;
      }
    }

    const updated = Object.keys(data).length
      ? await tx.attempt.update({ where: { id: attempt.id }, data })
      : attempt;

    await tx.intervention.create({
      data: {
        attemptId: attempt.id,
        actorId: actor.actorId,
        action: body.action,
        params,
        reason,
      },
    });

    await writeAudit(tx, actor, {
      action: `attempt.intervene.${body.action.toLowerCase()}`,
      targetType: 'Attempt',
      targetId: attempt.id,
      before: { status: attempt.status, extraMinutes: attempt.extraMinutes },
      after: {
        status: updated.status,
        extraMinutes: updated.extraMinutes,
        deadlineAt: updated.deadlineAt,
        params,
        reason,
      },
    });

    return updated;
  });

  // Broadcast real-time intervention to student and sitting proctor room
  void publishRealtimeEvent({
    event: 'attempt.intervene',
    target: {
      userIds: [result.studentId],
      rooms: [`sitting:${sittingId}`],
    },
    data: {
      sittingId,
      attemptId: result.id,
      studentId: result.studentId,
      action: body.action,
      reason: body.reason?.trim() || ACTION_REASON[body.action],
      status: result.status,
      extraMinutes: result.extraMinutes,
      deadlineAt: result.deadlineAt ? result.deadlineAt.toISOString() : null,
      message: body.action === 'MESSAGE' ? (body.message?.trim() || null) : null,
    },
  });

  res.json({
    data: {
      attemptId: result.id,
      action: body.action,
      status: result.status,
      extraMinutes: result.extraMinutes,
      deadlineAt: result.deadlineAt,
    },
  });
};

export const broadcast = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const body = z
    .object({
      message: z.string().trim().min(1).max(500),
      reason: z.string().trim().max(500).optional(),
    })
    .parse(req.body);
  const actor = actorFrom(req, res);

  const sitting = await prisma.sitting.findUnique({ where: { id: sittingId }, select: { id: true } });
  if (!sitting) throw Errors.notFound('Sitting');

  const count = await prisma.$transaction(async (tx) => {
    const attempts = await tx.attempt.findMany({
      where: { sittingId, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
      select: { id: true },
    });
    if (attempts.length) {
      await tx.intervention.createMany({
        data: attempts.map((a) => ({
          attemptId: a.id,
          actorId: actor.actorId,
          action: 'MESSAGE' as const,
          params: { message: body.message, broadcast: true },
          reason: body.reason?.trim() || 'Hall broadcast',
        })),
      });
    }
    await writeAudit(tx, actor, {
      action: 'sitting.broadcast',
      targetType: 'Sitting',
      targetId: sittingId,
      after: { message: body.message, recipients: attempts.length },
    });
    return attempts.length;
  });

  // Broadcast real-time announcement to sitting room
  void publishRealtimeEvent({
    event: 'sitting.broadcast',
    target: {
      rooms: [`sitting:${sittingId}`],
      roles: ['STUDENT', 'ADMIN'],
    },
    data: {
      sittingId,
      message: body.message,
      reason: body.reason || 'Hall broadcast',
      sentAt: new Date().toISOString(),
    },
  });

  res.json({ data: { sittingId, recipients: count } });
};

export const extendAll = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const body = z
    .object({
      minutes: z.number().int().min(1).max(60),
      reason: z.string().trim().max(500).optional(),
    })
    .parse(req.body);
  const actor = actorFrom(req, res);

  const result = await prisma.$transaction(async (tx) => {
    const sitting = await tx.sitting.findUnique({ where: { id: sittingId }, select: { id: true } });
    if (!sitting) throw Errors.notFound('Sitting');

    const attempts = await tx.attempt.findMany({
      where: { sittingId, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
      select: { id: true, studentId: true, extraMinutes: true, deadlineAt: true },
    });

    for (const attempt of attempts) {
      await tx.attempt.update({
        where: { id: attempt.id },
        data: {
          extraMinutes: attempt.extraMinutes + body.minutes,
          ...(attempt.deadlineAt
            ? { deadlineAt: new Date(attempt.deadlineAt.getTime() + body.minutes * 60_000) }
            : {}),
        },
      });
    }
    if (attempts.length) {
      await tx.intervention.createMany({
        data: attempts.map((a) => ({
          attemptId: a.id,
          actorId: actor.actorId,
          action: 'EXTEND' as const,
          params: { minutes: body.minutes, hallWide: true },
          reason: body.reason?.trim() || `Hall-wide ${body.minutes}-minute extension`,
        })),
      });
      await tx.sittingStudent.updateMany({
        where: { sittingId, studentId: { in: attempts.map((a) => a.studentId) } },
        data: { extraMinutes: { increment: body.minutes } },
      });
    }

    await writeAudit(tx, actor, {
      action: 'sitting.extend_all',
      targetType: 'Sitting',
      targetId: sittingId,
      after: { minutes: body.minutes, recipients: attempts.length },
    });
    return { count: attempts.length };
  });

  // Broadcast real-time sitting extension to all participants
  void publishRealtimeEvent({
    event: 'sitting.extend_all',
    target: {
      rooms: [`sitting:${sittingId}`],
      roles: ['STUDENT', 'ADMIN'],
    },
    data: {
      sittingId,
      minutes: body.minutes,
      reason: body.reason || `Hall-wide ${body.minutes}-minute extension`,
    },
  });

  res.json({ data: { sittingId, minutes: body.minutes, recipients: result.count } });
};

async function loadAttemptInSitting(sittingId: string, attemptId: string) {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.sittingId !== sittingId) throw Errors.notFound('Attempt');
  return attempt;
}

export const clearFlags = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const attemptId = uuidParam(req, 'attemptId');
  const actor = actorFrom(req, res);
  await loadAttemptInSitting(sittingId, attemptId);

  const result = await prisma.$transaction(async (tx) => {
    const flags = await tx.flag.updateMany({
      where: { attemptId, reviewedAt: null },
      data: { reviewedAt: new Date(), reviewedBy: actor.actorId },
    });
    await writeAudit(tx, actor, {
      action: 'attempt.clear_flags',
      targetType: 'Attempt',
      targetId: attemptId,
      after: { resolved: flags.count },
    });
    return flags;
  });

  void publishRealtimeEvent({
    event: 'attempt.flags_cleared',
    target: {
      rooms: [`sitting:${sittingId}`],
    },
    data: {
      sittingId,
      attemptId,
      resolved: result.count,
    },
  });

  res.json({ data: { attemptId, resolved: result.count } });
};

export const addFlag = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const attemptId = uuidParam(req, 'attemptId');
  const body = z
    .object({
      severity: z.enum(['INFO', 'WARNING', 'HIGH']).default('WARNING'),
      note: z.string().trim().max(1000).optional(),
    })
    .parse(req.body);
  const actor = actorFrom(req, res);
  await loadAttemptInSitting(sittingId, attemptId);

  const created = await prisma.$transaction(async (tx) => {
    const flag = await tx.flag.create({
      data: {
        attemptId,
        ruleKey: 'MANUAL_INVIGILATOR',
        severity: body.severity,
        details: body.note ? { note: body.note, by: actor.actorId } : { by: actor.actorId },
      },
    });
    await writeAudit(tx, actor, {
      action: 'attempt.flag',
      targetType: 'Attempt',
      targetId: attemptId,
      after: { flagId: flag.id, severity: flag.severity, note: body.note ?? null },
    });
    return flag;
  });

  void publishRealtimeEvent({
    event: 'attempt.flagged',
    target: {
      rooms: [`sitting:${sittingId}`],
    },
    data: {
      sittingId,
      attemptId,
      flagId: created.id,
      severity: created.severity,
      ruleKey: created.ruleKey,
    },
  });

  res.status(201).json({ data: created });
};

export const reassignSeat = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const attemptId = uuidParam(req, 'attemptId');
  const body = z.object({ seatLabel: z.string().trim().min(1).max(40) }).parse(req.body);
  const actor = actorFrom(req, res);

  const attempt = await loadAttemptInSitting(sittingId, attemptId);
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.sittingStudent.findUnique({
      where: { sittingId_studentId: { sittingId, studentId: attempt.studentId } },
    });
    if (!row) throw Errors.notFound('Sitting candidate');
    const next = await tx.sittingStudent.update({
      where: { sittingId_studentId: { sittingId, studentId: attempt.studentId } },
      data: { seatLabel: body.seatLabel },
    });
    await writeAudit(tx, actor, {
      action: 'attempt.reassign_seat',
      targetType: 'Attempt',
      targetId: attemptId,
      before: { seatLabel: row.seatLabel },
      after: { seatLabel: next.seatLabel },
    });
    return next;
  });

  void publishRealtimeEvent({
    event: 'attempt.seat_reassigned',
    target: {
      rooms: [`sitting:${sittingId}`],
      userIds: [attempt.studentId],
    },
    data: {
      sittingId,
      attemptId,
      studentId: attempt.studentId,
      seatLabel: updated.seatLabel,
    },
  });

  res.json({ data: { attemptId, seatLabel: updated.seatLabel } });
};

export const exportProctorLog = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const sitting = await prisma.sitting.findUnique({
    where: { id },
    select: {
      id: true,
      venue: true,
      startsAt: true,
      exam: { select: { title: true, course: { select: { code: true } } } },
      students: {
        select: { studentId: true, seatLabel: true, student: { select: { names: true, matricNo: true } } },
      },
      attempts: {
        select: {
          id: true,
          studentId: true,
          status: true,
          startedAt: true,
          submittedAt: true,
          extraMinutes: true,
          flags: { select: { id: true, ruleKey: true, severity: true, reviewedAt: true } },
          interventions: { select: { action: true, reason: true, createdAt: true } },
        },
      },
    },
  });
  if (!sitting) throw Errors.notFound('Sitting');

  const header = [
    'Seat', 'Matric No', 'Candidate', 'Status', 'Flags', 'Interventions',
    'Started At', 'Submitted At', 'Extra Minutes',
  ];
  const rows = sitting.students.map((s) => {
    const attempt = sitting.attempts.find((a) => a.studentId === s.studentId);
    return [
      s.seatLabel ?? '',
      s.student.matricNo ?? '',
      s.student.names,
      attempt?.status ?? 'NOT_STARTED',
      attempt?.flags.length ?? 0,
      attempt?.interventions.length ?? 0,
      attempt?.startedAt?.toISOString() ?? '',
      attempt?.submittedAt?.toISOString() ?? '',
      attempt?.extraMinutes ?? 0,
    ];
  });

  sendCsv(
    res,
    `proctor-log-${(sitting.exam.course?.code ?? sitting.exam.title).replace(/\s+/g, '-')}-${fmtDay(sitting.startsAt)}.csv`,
    toCsv(header, rows),
  );
};
