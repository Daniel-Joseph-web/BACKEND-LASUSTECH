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
      ...(q.sessionId ? { sessionId: q.sessionId } : {}),
    },
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      audience: true,
      durationMin: true,
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
      durationMin: e.durationMin,
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
 * Allows up to two concurrent institution sittings (e.g. parallel halls or two exams on the same day).
 * Public exams use a hidden sitting and are excluded.
 */
async function assertNoSittingOverlap(startsAt: Date, endsAt: Date, excludeId?: string, client?: any) {
  const db = client || prisma;
  const clashes = await db.sitting.findMany({
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
  if (clashes.length >= 2) {
    const clash = clashes[0];
    const clashExam = clash.exam.course
      ? `${clash.exam.course.code} — ${clash.exam.course.title}`
      : (clash.exam.subject?.name ?? clash.exam.title);
    const from = clash.startsAt.toISOString().slice(11, 16);
    const to = clash.endsAt.toISOString().slice(11, 16);
    throw Errors.conflict(
      'TIME_CLASH',
      `A maximum of 2 concurrent exams may be scheduled on this slot. Slot already has ${clashes.length} active exams (including ${clashExam} from ${from}–${to} UTC).`,
      { startsAt: clash.startsAt, endsAt: clash.endsAt },
    );
  }
}

async function assertInvigilatorsFree(
  userIds: string[],
  startsAt: Date,
  endsAt: Date,
  excludeId?: string,
  client?: any,
) {
  if (!userIds.length) return;
  const db = client || prisma;
  const clash = await db.sittingInvigilator.findFirst({
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
  durationMin: z.number().int().min(5).max(600).optional(),
  // Kept optional for older clients; the timetable no longer asks for a venue.
  venueId: z.uuid().optional(),
  invigilatorIds: z.array(z.uuid()).max(20).default([]),
  deliveryMode: z.enum(['LAB', 'REMOTE']).default('LAB'),
  requireWebcam: z.boolean().default(true),
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
        durationMin: true,
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

  // Exam duration is prescribed strictly by the course lecturer on the Exam entity.
  // Admins only schedule the examination window, start time, and proctoring policy.
  const sittingDuration = exam.durationMin || body.durationMin || 60;

  // Optional for compatibility; new sittings are simply "online / no venue".
  const venue = body.venueId
    ? await prisma.venue.findUnique({ where: { id: body.venueId } })
    : null;
  if (body.venueId && (!venue || !venue.active)) throw Errors.notFound('Venue');

  const startsAt = new Date(body.startsAt);
  if (Number.isNaN(startsAt.getTime())) throw Errors.badRequest('INVALID_DATE', 'Enter a valid start date and time.');
  const endsAt = body.endsAt
    ? new Date(body.endsAt)
    : new Date(startsAt.getTime() + sittingDuration * 60_000);
  if (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw Errors.badRequest('INVALID_WINDOW', 'The exam window end time must be after the start time.');
  }
  if (startsAt.getTime() < Date.now() - 5 * 60_000) {
    throw Errors.badRequest('START_IN_PAST', 'The start time is in the past.');
  }

  const examCourse = exam.courseId
    ? await prisma.course.findUnique({
        where: { id: exam.courseId },
        select: { departmentId: true, level: true },
      })
    : null;

  const [enrolledStudents, departmentStudents] = await Promise.all([
    exam.courseId
      ? prisma.enrollment.findMany({
          where: {
            courseId: exam.courseId,
            status: 'ACTIVE',
          },
          select: { studentId: true },
        })
      : Promise.resolve([]),
    examCourse?.departmentId
      ? prisma.user.findMany({
          where: {
            departmentId: examCourse.departmentId,
            roles: { some: { role: { key: 'STUDENT' } } },
            status: 'ACTIVE',
          },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  const candidateIdSet = new Set<string>([
    ...enrolledStudents.map((e) => e.studentId),
    ...departmentStudents.map((d) => d.id),
  ]);

  const candidates = [...candidateIdSet].map((studentId) => ({ studentId }));

  const accessCode = generateAccessCode();
  const accessCodeHash = await hashAccessCode(accessCode);
  const courseLabel = exam.course ? `${exam.course.code} — ${exam.course.title}` : exam.title;

  const created = await prisma.$transaction(async (tx) => {
    // 1. Guard against duplicate scheduling: Exam cannot be scheduled twice for active sittings
    const existingActive = await tx.sitting.findFirst({
      where: {
        examId: exam.id,
        status: { in: ['SCHEDULED', 'OPEN'] },
      },
      select: { id: true, startsAt: true, status: true },
    });
    if (existingActive) {
      throw Errors.conflict(
        'EXAM_ALREADY_SCHEDULED',
        'This exam is already scheduled for an active sitting. An exam cannot be scheduled twice while another sitting is active or scheduled.',
        { sittingId: existingActive.id, startsAt: existingActive.startsAt, status: existingActive.status },
      );
    }

    // 2. Transactional overlap and invigilator checks to avoid race conditions
    await assertNoSittingOverlap(startsAt, endsAt, undefined, tx);
    await assertInvigilatorsFree(body.invigilatorIds, startsAt, endsAt, undefined, tx);

    const sitting = await tx.sitting.create({
      data: {
        examId: exam.id,
        startsAt,
        endsAt,
        durationMin: sittingDuration,
        timerMode: body.timerMode,
        lateGraceMin: examSettings.lateLoginGraceMins,
        lateCutoffMin: examSettings.lateLoginCutoffMins,
        clockPolicy: examSettings.disconnectClockPolicy,
        maxPauseMin: 15,
        reconnectGraceSec: 60,
        venue: venue?.name ?? null,
        venueId: venue?.id ?? null,
        deliveryMode: body.deliveryMode,
        requireWebcam: body.requireWebcam ?? true,
        requireSeb: body.requireSeb,
        isPublic: exam.audience === 'PUBLIC',
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
        durationMin: sittingDuration,
        requireWebcam: body.requireWebcam ?? true,
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
          durationMin: true,
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

  // Admin cannot change exam duration time; duration is set by the course lecturer on the Exam.
  const durationMin = sitting.exam.durationMin ?? sitting.durationMin;
  const endsAt = body.endsAt
    ? new Date(body.endsAt)
    : (body.startsAt && sitting.endsAt > startsAt
      ? sitting.endsAt
      : new Date(startsAt.getTime() + durationMin * 60_000));
  if (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    throw Errors.badRequest('INVALID_WINDOW', 'The exam window end time must be after the start time.');
  }
  const examLabel = sitting.exam.course
    ? sitting.exam.course.code
    : (sitting.exam.subject?.name ?? sitting.exam.title);

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
    await assertNoSittingOverlap(startsAt, endsAt, id, tx);
    if (body.invigilatorIds) await assertInvigilatorsFree(body.invigilatorIds, startsAt, endsAt, id, tx);
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

    if (body.accessCode) {
      void publishRealtimeEvent({
        event: 'sitting.access_code_updated',
        target: {
          rooms: [`sitting:${id}`],
          roles: ['ADMIN'],
        },
        data: {
          sittingId: id,
          accessCode: body.accessCode,
          courseLabel: examLabel,
          updatedAt: new Date().toISOString(),
        },
      });
    }

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

    void publishRealtimeEvent({
      event: 'sitting.access_code_updated',
      target: {
        rooms: [`sitting:${id}`],
        roles: ['ADMIN'],
      },
      data: {
        sittingId: id,
        accessCode,
        courseLabel,
        updatedAt: new Date().toISOString(),
      },
    });
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const admitSchema = z.object({
  identifier: z.string().trim().min(2), // matricNo, email, or userId
  seatLabel: z.string().trim().max(40).optional(),
});

export const admitStudentToSitting = async (req: Request, res: Response) => {
  const sittingId = uuidParam(req);
  const body = admitSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const sitting = await prisma.sitting.findUnique({
    where: { id: sittingId },
    select: {
      id: true,
      status: true,
      exam: { select: { title: true, courseId: true, course: { select: { code: true } } } },
    },
  });
  if (!sitting) throw Errors.notFound('Sitting');
  if (sitting.status === 'CLOSED' || sitting.status === 'CANCELLED') {
    throw Errors.conflict('SITTING_CLOSED', 'Cannot admit candidates to a closed or cancelled sitting.');
  }

  const isUuid = UUID_RE.test(body.identifier);
  const student = await prisma.user.findFirst({
    where: {
      OR: [
        ...(isUuid ? [{ id: body.identifier }] : []),
        { matricNo: { equals: body.identifier, mode: 'insensitive' as const } },
        { email: { equals: body.identifier, mode: 'insensitive' as const } },
      ],
      roles: { some: { role: { key: 'STUDENT' } } },
    },
    select: { id: true, names: true, matricNo: true, email: true },
  });
  if (!student) {
    throw Errors.notFound('Student with that matric number or email was not found.');
  }

  const admitted = await prisma.$transaction(async (tx) => {
    const sittingStudent = await tx.sittingStudent.upsert({
      where: {
        sittingId_studentId: {
          sittingId,
          studentId: student.id,
        },
      },
      create: {
        sittingId,
        studentId: student.id,
        seatLabel: body.seatLabel || `Seat-${Math.floor(Math.random() * 900 + 100)}`,
      },
      update: {
        seatLabel: body.seatLabel || undefined,
      },
    });

    // Also enroll them in the course if the exam has a course
    if (sitting.exam.courseId) {
      const currentSession = await tx.academicSession.findFirst({ where: { isCurrent: true }, select: { id: true } });
      if (currentSession) {
        await tx.enrollment.upsert({
          where: {
            studentId_courseId_sessionId: {
              studentId: student.id,
              courseId: sitting.exam.courseId,
              sessionId: currentSession.id,
            },
          },
          create: {
            studentId: student.id,
            courseId: sitting.exam.courseId,
            sessionId: currentSession.id,
            status: 'ACTIVE',
          },
          update: { status: 'ACTIVE' },
        });
      }
    }

    await writeAudit(tx, actor, {
      action: 'sitting.admit_student',
      targetType: 'Sitting',
      targetId: sittingId,
      after: { studentId: student.id, matricNo: student.matricNo, seatLabel: sittingStudent.seatLabel },
    });

    return sittingStudent;
  });

  res.json({
    data: {
      sittingId,
      studentId: student.id,
      names: student.names,
      matricNo: student.matricNo,
      seatLabel: admitted.seatLabel,
      message: `${student.names} has been admitted to this exam sitting.`,
    },
  });
};

export const getSittingAttendance = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const sitting = await prisma.sitting.findUnique({
    where: { id },
    include: {
      exam: {
        include: {
          course: true,
          subject: true,
          session: true,
        },
      },
      venueRef: true,
      invigilators: {
        include: {
          user: {
            select: { id: true, names: true, staffId: true, email: true },
          },
        },
      },
      students: {
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
        },
        orderBy: [
          { student: { matricNo: 'asc' } },
          { student: { names: 'asc' } },
        ],
      },
      attempts: {
        select: {
          id: true,
          studentId: true,
          status: true,
          startedAt: true,
          submittedAt: true,
          ipStart: true,
        },
      },
    },
  });

  if (!sitting) throw Errors.notFound('Sitting');

  const attemptsByStudent = new Map(sitting.attempts.map((a) => [a.studentId, a]));

  const attendees = sitting.students.map((st, index) => {
    const attempt = attemptsByStudent.get(st.studentId);
    const isPresent = Boolean(attempt && attempt.startedAt);
    return {
      sn: index + 1,
      studentId: st.studentId,
      matricNo: st.student.matricNo ?? '—',
      names: st.student.names,
      department: st.student.department?.name ?? '—',
      seatLabel: st.seatLabel ?? '—',
      isPresent,
      attemptStatus: attempt?.status ?? 'NOT_STARTED',
      startedAt: attempt?.startedAt ? attempt.startedAt.toISOString() : null,
      submittedAt: attempt?.submittedAt ? attempt.submittedAt.toISOString() : null,
      ipAddress: attempt?.ipStart ?? null,
    };
  });

  const presentCount = attendees.filter((a) => a.isPresent).length;
  const absentCount = attendees.length - presentCount;

  res.json({
    data: {
      sittingId: sitting.id,
      examTitle: sitting.exam.title,
      courseCode: sitting.exam.course?.code ?? sitting.exam.subject?.name ?? 'EXAM',
      courseTitle: sitting.exam.course?.title ?? sitting.exam.title,
      level: sitting.exam.course?.level ?? null,
      sessionName: sitting.exam.session?.name ?? 'Current Session',
      startsAt: sitting.startsAt.toISOString(),
      endsAt: sitting.endsAt.toISOString(),
      durationMin: sitting.durationMin,
      venue: sitting.venue ?? sitting.venueRef?.name ?? 'CBT Centre',
      venueCapacity: sitting.venueRef?.capacity ?? null,
      deliveryMode: sitting.deliveryMode,
      requireWebcam: sitting.requireWebcam,
      totalRegistered: attendees.length,
      presentCount,
      absentCount,
      invigilators: sitting.invigilators.map((i) => ({
        id: i.user.id,
        names: i.user.names,
        staffId: i.user.staffId ?? '—',
      })),
      attendees,
    },
  });
};
