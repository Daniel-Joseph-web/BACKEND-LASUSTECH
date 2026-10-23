import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Request, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { pageMeta, pageShape, uuidParam } from '../../lib/http';
import { getGroup } from '../../lib/settings';
import { lagosDateTime, notifyUsers } from '../../lib/notify';
import { publishRealtimeEvent } from '../../lib/realtime';
import { closeExpiredSittings } from '../student/student.service';

const sittingInclude = {
  exam: {
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      audience: true,
      course: { select: { id: true, code: true, title: true, level: true } },
      subject: { select: { id: true, name: true, level: true, institution: true } },
      session: { select: { id: true, name: true } },
    },
  },
  venueRef: { select: { id: true, code: true, name: true, capacity: true } },
  invigilators: {
    select: { user: { select: { id: true, names: true, staffId: true } } },
  },
  _count: { select: { students: true, attempts: true } },
} satisfies Prisma.SittingInclude;

type SittingRow = Prisma.SittingGetPayload<{ include: typeof sittingInclude }>;

const examLabel = (exam: SittingRow['exam']) =>
  exam.course
    ? `${exam.course.code} — ${exam.course.title}`
    : (exam.subject?.name ?? exam.title);

const present = (s: SittingRow) => ({
  id: s.id,
  examId: s.examId,
  examTitle: s.exam.title,
  examKind: s.exam.kind,
  examStatus: s.exam.status,
  audience: s.exam.audience,
  courseId: s.exam.course?.id ?? null,
  courseCode: s.exam.course?.code ?? null,
  courseTitle: s.exam.course?.title ?? null,
  courseLevel: s.exam.course?.level ?? null,
  subjectId: s.exam.subject?.id ?? null,
  subjectName: s.exam.subject?.name ?? null,
  ownerLabel: examLabel(s.exam),
  sessionId: s.exam.session?.id ?? null,
  sessionName: s.exam.session?.name ?? null,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  durationMin: s.durationMin,
  lateGraceMin: s.lateGraceMin,
  lateCutoffMin: s.lateCutoffMin,
  venue: s.venue,
  venueId: s.venueId,
  venueCapacity: s.venueRef?.capacity ?? null,
  status: s.status,
  deliveryMode: s.deliveryMode,
  requireWebcam: s.requireWebcam,
  requireSeb: s.requireSeb,
  registered: s._count.students,
  attempts: s._count.attempts,
  invigilators: s.invigilators.map((i) => i.user),
});

const listQuery = z.object({
  ...pageShape,
  search: z.string().trim().max(120).optional(),
  status: z.enum(['ALL', 'SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED']).default('ALL'),
  sessionId: z.uuid().optional(),
});

export const listSchedule = async (req: Request, res: Response) => {
  await closeExpiredSittings();
  const q = listQuery.parse(req.query);
  const where: Prisma.SittingWhereInput = {};
  if (q.status !== 'ALL') where.status = q.status;
  if (q.sessionId) where.exam = { sessionId: q.sessionId };
  if (q.search) {
    const search = q.search;
    where.OR = [
      { venue: { contains: search, mode: 'insensitive' } },
      { exam: { title: { contains: search, mode: 'insensitive' } } },
      { exam: { course: { code: { contains: search, mode: 'insensitive' } } } },
      { exam: { course: { title: { contains: search, mode: 'insensitive' } } } },
      { exam: { subject: { name: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  const [rows, total, scheduled, open, closed, cancelled] = await Promise.all([
    prisma.sitting.findMany({
      where,
      include: sittingInclude,
      orderBy: { startsAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.sitting.count({ where }),
    prisma.sitting.count({ where: { status: 'SCHEDULED' } }),
    prisma.sitting.count({ where: { status: 'OPEN' } }),
    prisma.sitting.count({ where: { status: 'CLOSED' } }),
    prisma.sitting.count({ where: { status: 'CANCELLED' } }),
  ]);

  res.json({
    data: rows.map(present),
    meta: { ...pageMeta(q.page, q.pageSize, total), counts: { scheduled, open, closed, cancelled } },
  });
};

/** Exams that are ready to be scheduled (approved or locked). */
export const listSchedulableExams = async (req: Request, res: Response) => {
  const q = z.object({ sessionId: z.uuid().optional() }).parse(req.query);
  const exams = await prisma.exam.findMany({
    where: {
      status: { in: ['APPROVED', 'LOCKED'] },
      audience: 'INSTITUTIONAL',
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
    },
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      audience: true,
      course: { select: { id: true, code: true, title: true, level: true } },
      subject: { select: { id: true, name: true, level: true, institution: true } },
      session: { select: { id: true, name: true } },
      _count: { select: { sittings: true } },
    },
    orderBy: [{ session: { name: 'desc' } }, { course: { code: 'asc' } }, { createdAt: 'desc' }],
  });
  res.json({
    data: exams.map((e) => ({
      id: e.id,
      title: e.title,
      kind: e.kind,
      status: e.status,
      audience: e.audience,
      courseId: e.course?.id ?? null,
      courseCode: e.course?.code ?? (e.subject?.name ?? 'EXAM'),
      courseTitle: e.course?.title ?? (e.subject?.institution ? `${e.subject.name} (${e.subject.institution})` : e.title),
      courseLevel: e.course?.level ?? (e.subject?.level ? parseInt(e.subject.level, 10) || null : null),
      sessionId: e.session?.id ?? null,
      sessionName: e.session?.name ?? (e.audience === 'PUBLIC' ? 'Open / Public' : null),
      sittings: e._count.sittings,
    })),
  });
};

export const listVenues = async (_req: Request, res: Response) => {
  const venues = await prisma.venue.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true, capacity: true, location: true },
    orderBy: { name: 'asc' },
  });
  res.json({ data: venues });
};

export const listInvigilators = async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      roles: { some: { role: { key: { in: ['LECTURER', 'ADMIN'] } } } },
    },
    select: {
      id: true,
      names: true,
      staffId: true,
      email: true,
      roles: { select: { role: { select: { key: true } } } },
    },
    orderBy: { names: 'asc' },
    take: 500,
  });
  res.json({
    data: users.map((u) => ({
      id: u.id,
      names: u.names,
      staffId: u.staffId,
      email: u.email,
      roles: u.roles.map((r) => r.role.key),
    })),
  });
};

const generateAccessCode = () => String(crypto.randomInt(100000, 1000000));
const hashAccessCode = (code: string) => bcrypt.hash(code, 10);

/**
 * One institution sitting at a time. There is no venue dimension any more, so
 * two school papers may never overlap. Public exams use a hidden sitting and
 * are excluded — a candidate online does not occupy the CBT hall.
 */
async function assertNoSittingOverlap(startsAt: Date, endsAt: Date, excludeId?: string) {
  const clash = await prisma.sitting.findFirst({
    where: {
      isPublic: false,
      status: { not: 'CANCELLED' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    select: {
      startsAt: true,
      endsAt: true,
      exam: {
        select: {
          title: true,
          course: { select: { code: true, title: true } },
          subject: { select: { name: true } },
        },
      },
    },
  });
  if (clash) {
    const clashExam = clash.exam.course
      ? `${clash.exam.course.code} — ${clash.exam.course.title}`
      : (clash.exam.subject?.name ?? clash.exam.title);
    const from = clash.startsAt.toISOString().slice(11, 16);
    const to = clash.endsAt.toISOString().slice(11, 16);
    throw Errors.conflict(
      'TIME_CLASH',
      `${clashExam} is already scheduled ${from}–${to} UTC. Only one school sitting can run at a time; pick a free slot.`,
      { startsAt: clash.startsAt, endsAt: clash.endsAt },
    );
  }
}

async function assertInvigilatorsFree(
  userIds: string[],
  startsAt: Date,
  endsAt: Date,
  excludeId?: string,
) {
  if (!userIds.length) return;
  const clash = await prisma.sittingInvigilator.findFirst({
    where: {
      userId: { in: userIds },
      sitting: {
        isPublic: false,
        status: { not: 'CANCELLED' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    },
    select: { user: { select: { names: true } } },
  });
  if (clash) {
    throw Errors.conflict(
      'INVIGILATOR_BUSY',
      `${clash.user.names} is already invigilating another sitting at that time.`,
    );
  }
}

const createSchema = z.object({
  examId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  durationMin: z.number().int().min(5).max(600),
  // Kept optional for older clients; the timetable no longer asks for a venue.
  venueId: z.uuid().optional(),
  invigilatorIds: z.array(z.uuid()).max(20).default([]),
  deliveryMode: z.enum(['LAB', 'REMOTE']).default('LAB'),
  requireWebcam: z.boolean().default(false),
  requireSeb: z.boolean().default(false),
  timerMode: z.enum(['PER_STUDENT_START', 'FIXED_END']).default('PER_STUDENT_START'),
});

export const createSitting = async (req: Request, res: Response) => {
  const body = createSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const [exam, examSettings] = await Promise.all([
    prisma.exam.findUnique({
      where: { id: body.examId },
      select: {
        id: true,
        status: true,
        audience: true,
        courseId: true,
        sessionId: true,
        createdBy: true,
        title: true,
        course: { select: { code: true, title: true } },
      },
    }),
    getGroup('exam'),
  ]);
  if (!exam) throw Errors.notFound('Exam');
  if (exam.status !== 'APPROVED' && exam.status !== 'LOCKED') {
    throw Errors.conflict(
      'EXAM_NOT_READY',
      'Only approved or locked exams can be scheduled.',
      { status: exam.status },
    );
  }
  // Optional for compatibility; new sittings are simply "online / no venue".
  const venue = body.venueId
    ? await prisma.venue.findUnique({ where: { id: body.venueId } })
    : null;
  if (body.venueId && (!venue || !venue.active)) throw Errors.notFound('Venue');

  const startsAt = new Date(body.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw Errors.badRequest('INVALID_DATE', 'Enter a valid start date and time.');
  const endsAt = body.endsAt
    ? new Date(body.endsAt)
    : new Date(startsAt.getTime() + body.durationMin * 60_000);
  if (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw Errors.badRequest('INVALID_WINDOW', 'The exam window end time must be after the start time.');
  }
  if (startsAt.getTime() < Date.now() - 5 * 60_000) {
    throw Errors.badRequest('START_IN_PAST', 'The start time is in the past.');
  }

  await assertNoSittingOverlap(startsAt, endsAt);
  await assertInvigilatorsFree(body.invigilatorIds, startsAt, endsAt);

  const candidates = exam.courseId
    ? await prisma.enrollment.findMany({
        where: {
          courseId: exam.courseId,
          ...(exam.sessionId ? { sessionId: exam.sessionId } : {}),
          status: 'ACTIVE',
        },
        select: { studentId: true },
      })
    : [];

  const accessCode = generateAccessCode();
  const accessCodeHash = await hashAccessCode(accessCode);
  const courseLabel = exam.course ? `${exam.course.code} — ${exam.course.title}` : exam.title;

  const created = await prisma.$transaction(async (tx) => {
    const sitting = await tx.sitting.create({
      data: {
        examId: exam.id,
        startsAt,
        endsAt,
        durationMin: body.durationMin,
        timerMode: body.timerMode,
        lateGraceMin: examSettings.lateLoginGraceMins,
        lateCutoffMin: examSettings.lateLoginCutoffMins,
        clockPolicy: examSettings.disconnectClockPolicy,
        maxPauseMin: 15,
        reconnectGraceSec: 60,
        venue: venue?.name ?? null,
        venueId: venue?.id ?? null,
        deliveryMode: body.deliveryMode,
        requireWebcam: body.requireWebcam,
        requireSeb: body.requireSeb,
        accessCodeHash,
        status: 'SCHEDULED',
        students: {
          createMany: {
            data: candidates.map((c) => ({ studentId: c.studentId })),
            skipDuplicates: true,
          },
        },
        invigilators: {
          createMany: {
            data: body.invigilatorIds.map((userId) => ({ userId })),
            skipDuplicates: true,
          },
        },
      },
    });

    await writeAudit(tx, actor, {
      action: 'sitting.create',
      targetType: 'Sitting',
      targetId: sitting.id,
      after: {
        exam: exam.title,
        startsAt: startsAt.toISOString(),
        durationMin: body.durationMin,
        candidates: candidates.length,
        invigilators: body.invigilatorIds.length,
      },
    });

    await notifyUsers(
      tx,
      candidates.map((c) => c.studentId),
      {
        type: 'EXAM_REMINDER',
        title: `Exam Access Code & Schedule: ${courseLabel}`,
        body: `${courseLabel} takes place ${lagosDateTime(startsAt)}. Your Exam Unlock Access Code is: ${accessCode}. Use this code to unlock your examination.`,
        meta: { kind: 'SCHEDULED', sittingId: sitting.id, accessCode, href: `/student/exam/${sitting.id}/start?code=${accessCode}` },
      },
    );

    // Also notify assigned lecturers and invigilators
    const lecturerRecipients = [...new Set([exam.createdBy, ...body.invigilatorIds].filter(Boolean))] as string[];
    if (lecturerRecipients.length > 0) {
      await notifyUsers(
        tx,
        lecturerRecipients,
        {
          type: 'EXAM_REMINDER',
          title: `Sitting Scheduled: ${courseLabel}`,
          body: `An exam sitting for "${exam.title}" has been scheduled for ${lagosDateTime(startsAt)}.`,
          meta: { kind: 'SITTING_SCHEDULED', sittingId: sitting.id, href: '/lecturer/exams' },
        },
      );
    }

    return sitting;
  });

  void publishRealtimeEvent({
    event: 'sitting.created',
    target: { roles: ['ADMIN', 'LECTURER', 'STUDENT'] },
    data: {
      sittingId: created.id,
      examTitle: exam.title,
      startsAt: startsAt.toISOString(),
      courseLabel,
    },
  });

  const row = await prisma.sitting.findUnique({ where: { id: created.id }, include: sittingInclude });
  // The access code is shown to the administrator once; only its hash is stored.
  res.status(201).json({ data: { ...present(row!), accessCode } });
};

const updateSchema = z.object({
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  durationMin: z.number().int().min(5).max(600).optional(),
  invigilatorIds: z.array(z.uuid()).max(20).optional(),
  deliveryMode: z.enum(['LAB', 'REMOTE']).optional(),
  requireWebcam: z.boolean().optional(),
  requireSeb: z.boolean().optional(),
  timerMode: z.enum(['PER_STUDENT_START', 'FIXED_END']).optional(),
  accessCode: z.string().regex(/^\d{6}$/, 'Use a six-digit access code.').optional(),
});

export const updateSitting = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = updateSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const sitting = await prisma.sitting.findUnique({
    where: { id },
    include: {
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
  if (sitting.status === 'OPEN') {
    throw Errors.conflict('SITTING_OPEN', 'Close the sitting before editing its schedule.');
  }
  if (sitting.status === 'CLOSED' || sitting.status === 'CANCELLED') {
    throw Errors.conflict('SITTING_FINISHED', 'This sitting can no longer be edited.');
  }

  const startsAt = body.startsAt ? new Date(body.startsAt) : sitting.startsAt;
  if (Number.isNaN(startsAt.getTime())) throw Errors.badRequest('INVALID_DATE', 'Enter a valid start date and time.');
  const durationMin = body.durationMin ?? sitting.durationMin;
  const endsAt = body.endsAt
    ? new Date(body.endsAt)
    : (body.startsAt && !body.durationMin && sitting.endsAt > startsAt
      ? sitting.endsAt
      : new Date(startsAt.getTime() + durationMin * 60_000));
  if (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw Errors.badRequest('INVALID_WINDOW', 'The exam window end time must be after the start time.');
  }
  const examLabel = sitting.exam.course
    ? sitting.exam.course.code
    : (sitting.exam.subject?.name ?? sitting.exam.title);

  await assertNoSittingOverlap(startsAt, endsAt, id);
  if (body.invigilatorIds) await assertInvigilatorsFree(body.invigilatorIds, startsAt, endsAt, id);

  // Only a real move or re-duration is worth telling candidates about;
  // editing webcam/Seb settings must not produce noise.
  const scheduleChanged =
    startsAt.getTime() !== sitting.startsAt.getTime() || durationMin !== sitting.durationMin;

  const data: Prisma.SittingUpdateInput = {
    startsAt,
    endsAt,
    durationMin,
    ...(body.deliveryMode ? { deliveryMode: body.deliveryMode } : {}),
    ...(body.requireWebcam !== undefined ? { requireWebcam: body.requireWebcam } : {}),
    ...(body.requireSeb !== undefined ? { requireSeb: body.requireSeb } : {}),
    ...(body.timerMode ? { timerMode: body.timerMode } : {}),
    ...(body.accessCode ? { accessCodeHash: await hashAccessCode(body.accessCode) } : {}),
  };

  await prisma.$transaction(async (tx) => {
    await tx.sitting.update({ where: { id }, data });
    if (body.invigilatorIds) {
      await tx.sittingInvigilator.deleteMany({ where: { sittingId: id } });
      if (body.invigilatorIds.length) {
        await tx.sittingInvigilator.createMany({
          data: body.invigilatorIds.map((userId) => ({ sittingId: id, userId })),
          skipDuplicates: true,
        });
      }
    }
    await writeAudit(tx, actor, {
      action: 'sitting.update',
      targetType: 'Sitting',
      targetId: id,
      before: {
        startsAt: sitting.startsAt.toISOString(),
        durationMin: sitting.durationMin,
      },
      after: {
        startsAt: startsAt.toISOString(),
        durationMin,
        invigilators: body.invigilatorIds?.length ?? null,
      },
    });

    if (scheduleChanged) {
      const students = await tx.sittingStudent.findMany({
        where: { sittingId: id },
        select: { studentId: true },
      });
      await notifyUsers(
        tx,
        students.map((s) => s.studentId),
        {
          type: 'EXAM_REMINDER',
          title: 'Exam schedule changed',
          body: `${examLabel} — ${sitting.exam.title} now takes place ${lagosDateTime(startsAt)}.`,
          meta: { kind: 'UPDATED', sittingId: id, href: '/student' },
        },
      );
    }
  });

  const row = await prisma.sitting.findUnique({ where: { id }, include: sittingInclude });
  res.json({ data: present(row!) });
};

export const regenerateAccessCode = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const actor = actorFrom(req, res);
  const sitting = await prisma.sitting.findUnique({
    where: { id },
    include: {
      exam: { select: { title: true, course: { select: { code: true } }, subject: { select: { name: true } } } },
      students: { select: { studentId: true } },
    },
  });
  if (!sitting) throw Errors.notFound('Sitting');
  if (sitting.status === 'CLOSED' || sitting.status === 'CANCELLED') {
    throw Errors.conflict('SITTING_FINISHED', 'This sitting can no longer be edited.');
  }

  const accessCode = generateAccessCode();
  const accessCodeHash = await hashAccessCode(accessCode);
  const courseLabel = sitting.exam.course ? sitting.exam.course.code : (sitting.exam.subject?.name ?? sitting.exam.title);

  await prisma.$transaction(async (tx) => {
    await tx.sitting.update({ where: { id }, data: { accessCodeHash } });
    await writeAudit(tx, actor, {
      action: 'sitting.access_code',
      targetType: 'Sitting',
      targetId: id,
      after: { regenerated: true },
    });
    await notifyUsers(
      tx,
      sitting.students.map((s) => s.studentId),
      {
        type: 'EXAM_REMINDER',
        title: `Updated Exam Access Code: ${courseLabel}`,
        body: `The exam access code for ${courseLabel} is: ${accessCode}. Use this code to unlock and start your examination.`,
        meta: { kind: 'ACCESS_CODE', sittingId: id, accessCode, href: `/student/exam/${id}/start?code=${accessCode}` },
      },
    );
  });
  res.json({ data: { id, accessCode } });
};

const transition = async (
  req: Request,
  res: Response,
  to: 'OPEN' | 'CLOSED' | 'CANCELLED',
) => {
  const id = uuidParam(req);
  const actor = actorFrom(req, res);

  const updated = await prisma.$transaction(async (tx) => {
    const sitting = await tx.sitting.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        venue: true,
        startsAt: true,
        exam: {
          select: {
            title: true,
            course: { select: { code: true } },
            subject: { select: { name: true } },
          },
        },
        students: { select: { studentId: true } },
      },
    });
    if (!sitting) throw Errors.notFound('Sitting');
    if (sitting.status === to) throw Errors.conflict('ALREADY_IN_STATE', `This sitting is already ${to.toLowerCase()}.`);
    if (to === 'OPEN' && sitting.status !== 'SCHEDULED') {
      throw Errors.conflict('INVALID_TRANSITION', 'Only a scheduled sitting can be opened.');
    }
    if (to === 'CLOSED' && sitting.status !== 'OPEN') {
      throw Errors.conflict('INVALID_TRANSITION', 'Only an open sitting can be closed.');
    }
    if (to === 'CANCELLED' && (sitting.status === 'CLOSED' || sitting.status === 'CANCELLED')) {
      throw Errors.conflict('INVALID_TRANSITION', 'This sitting can no longer be cancelled.');
    }

    const after = await tx.sitting.update({ where: { id }, data: { status: to } });
    if (to === 'CLOSED' || to === 'CANCELLED') {
      await tx.attempt.updateMany({
        where: { sittingId: id, status: { in: ['IN_PROGRESS', 'PAUSED'] } },
        data: { status: 'TERMINATED', endedReason: 'INVIGILATOR_END', submittedAt: new Date() },
      });
    }
    await writeAudit(tx, actor, {
      action: `sitting.${to.toLowerCase()}`,
      targetType: 'Sitting',
      targetId: id,
      before: { status: sitting.status },
      after: { status: to },
    });

    const label = sitting.exam.course
      ? sitting.exam.course.code
      : (sitting.exam.subject?.name ?? sitting.exam.title);

    if (to === 'OPEN') {
      await notifyUsers(
        tx,
        sitting.students.map((s) => s.studentId),
        {
          type: 'EXAM_REMINDER',
          title: `Exam is Now Live: ${label}`,
          body: `${label} — ${sitting.exam.title} is now open. Proceed to your workstation.`,
          meta: { kind: 'EXAM_LIVE', sittingId: id, href: '/student' },
        },
      );
    } else if (to === 'CANCELLED') {
      await notifyUsers(
        tx,
        sitting.students.map((s) => s.studentId),
        {
          type: 'EXAM_REMINDER',
          title: 'Exam cancelled',
          body: `${label} — ${sitting.exam.title} on ${lagosDateTime(sitting.startsAt)} has been cancelled.`,
          meta: { kind: 'CANCELLED', sittingId: id, href: '/student' },
        },
      );
    }

    return after;
  });

  void publishRealtimeEvent({
    event: 'sitting.status',
    target: { roles: ['ADMIN', 'LECTURER', 'STUDENT'] },
    data: { sittingId: updated.id, status: to },
  });

  const row = await prisma.sitting.findUnique({ where: { id: updated.id }, include: sittingInclude });
  res.json({ data: present(row!) });
};

export const openSitting = (req: Request, res: Response) => transition(req, res, 'OPEN');
export const closeSitting = (req: Request, res: Response) => transition(req, res, 'CLOSED');
export const cancelSitting = (req: Request, res: Response) => transition(req, res, 'CANCELLED');

/**
 * Removes a sitting that never ran. Anything with candidate attempts,
 * incidents or result batches is history and must be cancelled instead.
 */
export const deleteSitting = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const sitting = await prisma.sitting.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      venue: true,
      startsAt: true,
      exam: {
        select: {
          title: true,
          course: { select: { code: true } },
          subject: { select: { name: true } },
        },
      },
      _count: { select: { attempts: true, incidents: true, batches: true } },
    },
  });
  if (!sitting) throw Errors.notFound('Sitting');
  if (sitting.status === 'OPEN') {
    throw Errors.conflict('SITTING_OPEN', 'Close the sitting before deleting it.');
  }
  if (sitting._count.attempts || sitting._count.incidents || sitting._count.batches) {
    throw Errors.conflict(
      'IN_USE',
      'This sitting has attempts, incidents or result batches. Cancel it instead of deleting.',
    );
  }

  const actor = actorFrom(req, res);

  await prisma.$transaction(async (tx) => {
    // Roster rows cascade, but delete them explicitly so the audit entry is
    // written in the same transaction as the removal.
    await tx.sittingInvigilator.deleteMany({ where: { sittingId: id } });
    await tx.sittingStudent.deleteMany({ where: { sittingId: id } });
    await tx.sitting.delete({ where: { id } });
    await writeAudit(tx, actor, {
      action: 'sitting.delete',
      targetType: 'Sitting',
      targetId: id,
      before: {
        course: sitting.exam.course?.code ?? null,
        exam: sitting.exam.title,
        venue: sitting.venue,
        startsAt: sitting.startsAt.toISOString(),
        status: sitting.status,
      },
    });
  });

  res.status(204).end();
};
