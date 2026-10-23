import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { dateOnly, fmtDay, parseDay, todayLagos, uuidParam } from '../../lib/http';

const SEMS = ['FIRST', 'SECOND'] as const;

const nameSchema = z.string().trim().refine((s) => {
  const m = /^(\d{4})\/(\d{4})$/.exec(s);
  return !!m && Number(m[2]) === Number(m[1]) + 1;
}, 'Use the format 2026/2027 (consecutive years).');

const ordered = (r: { startsOn: string; endsOn: string }) => r.startsOn < r.endsOn;
const orderedMsg = { message: 'End date must be after the start date.', path: ['endsOn'] };
const range = z.object({ startsOn: dateOnly, endsOn: dateOnly }).refine(ordered, orderedMsg);

const createSchema = z.object({ name: nameSchema, startsOn: dateOnly, endsOn: dateOnly }).refine(ordered, orderedMsg);
const updateSchema = z.object({
  name: nameSchema.optional(),
  startsOn: dateOnly.optional(),
  endsOn: dateOnly.optional(),
  semesters: z.object({ first: range, second: range }).optional(),
});

type SessionRow = Prisma.AcademicSessionGetPayload<{ include: { semesters: true } }>;

const statusOf = (s: SessionRow, today: Date) =>
  s.closedAt ? 'CLOSED' : s.isCurrent ? 'CURRENT' : s.endsOn < today ? 'ENDED' : 'UPCOMING';

async function loadSessions(where: Prisma.AcademicSessionWhereInput = {}) {
  const today = todayLagos();
  const [sessions, counts] = await Promise.all([
    prisma.academicSession.findMany({ where, include: { semesters: true }, orderBy: { startsOn: 'desc' } }),
    prisma.$queryRaw<{ sessionId: string; semester: string; count: number }[]>`
      SELECT e.session_id AS "sessionId", c.default_semester::text AS semester, COUNT(*)::int AS count
      FROM exams e JOIN courses c ON c.id = e.course_id GROUP BY 1, 2`,
  ]);
  return sessions.map((s) => {
    const semesters = SEMS.map((name) => {
      const sem = s.semesters.find((x) => x.name === name);
      const status = !sem ? 'UPCOMING' : s.closedAt || sem.endsOn < today ? 'COMPLETED' : s.isCurrent && sem.startsOn <= today ? 'ACTIVE' : 'UPCOMING';
      return {
        name, configured: !!sem,
        startsOn: sem ? fmtDay(sem.startsOn) : null, endsOn: sem ? fmtDay(sem.endsOn) : null,
        status, examCount: counts.find((c) => c.sessionId === s.id && c.semester === name)?.count ?? 0,
      };
    });
    return {
      id: s.id, name: s.name, startsOn: fmtDay(s.startsOn), endsOn: fmtDay(s.endsOn),
      isCurrent: s.isCurrent, closedAt: s.closedAt, status: statusOf(s, today),
      examCount: semesters.reduce((n, x) => n + x.examCount, 0), semesters,
    };
  });
}

async function assertNoOverlap(startsOn: Date, endsOn: Date, excludeId?: string) {
  const hit = await prisma.academicSession.findFirst({
    where: { ...(excludeId ? { id: { not: excludeId } } : {}), startsOn: { lte: endsOn }, endsOn: { gte: startsOn } },
    select: { name: true },
  });
  if (hit) throw Errors.conflict('SESSION_OVERLAP', `Those dates overlap with session ${hit.name}.`);
}

export const listSessions = async (_req: Request, res: Response) => res.json({ data: await loadSessions() });

/** Any signed-in user (topbar session switcher). */
export const listSessionsPublic = async (_req: Request, res: Response) => {
  const today = todayLagos();
  const sessions = await loadSessions();
  res.json({
    data: sessions.map((s) => {
      const active = s.semesters.find((x) => x.status === 'ACTIVE');
      return {
        id: s.id, name: s.name, status: s.status, isCurrent: s.isCurrent,
        label: active ? (active.name === 'FIRST' ? '1st Semester (Harmattan)' : '2nd Semester (Rain)') : s.status === 'CLOSED' ? 'Closed' : s.status === 'UPCOMING' ? 'Upcoming' : 'Between semesters',
        today: fmtDay(today),
      };
    }),
  });
};

export const createSession = async (req: Request, res: Response) => {
  const body = createSchema.parse(req.body);
  const startsOn = parseDay(body.startsOn), endsOn = parseDay(body.endsOn);
  if (await prisma.academicSession.findFirst({ where: { name: body.name }, select: { id: true } })) throw Errors.conflict('ALREADY_EXISTS', `Session ${body.name} already exists.`);
  await assertNoOverlap(startsOn, endsOn);
  const actor = actorFrom(req, res);

  const created = await prisma.$transaction(async (tx) => {
    const hasCurrent = !!(await tx.academicSession.findFirst({ where: { isCurrent: true }, select: { id: true } }));
    const s = await tx.academicSession.create({ data: { name: body.name, startsOn, endsOn, isCurrent: !hasCurrent } });
    await writeAudit(tx, actor, { action: 'session.create', targetType: 'AcademicSession', targetId: s.id, after: { name: s.name, startsOn: body.startsOn, endsOn: body.endsOn, isCurrent: s.isCurrent } });
    return s;
  });
  res.status(201).json({ data: (await loadSessions({ id: created.id }))[0] });
};

export const updateSession = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = updateSchema.parse(req.body);
  const s = await prisma.academicSession.findUnique({ where: { id }, include: { semesters: true } });
  if (!s) throw Errors.notFound('Session');
  if (s.closedAt) throw Errors.conflict('SESSION_CLOSED', 'A closed session can no longer be edited.');

  const startsOnStr = body.startsOn ?? fmtDay(s.startsOn);
  const endsOnStr = body.endsOn ?? fmtDay(s.endsOn);
  if (startsOnStr >= endsOnStr) throw Errors.badRequest('INVALID_RANGE', 'End date must be after the start date.');
  if (body.name && body.name !== s.name && (await prisma.academicSession.findFirst({ where: { name: body.name, id: { not: id } }, select: { id: true } }))) {
    throw Errors.conflict('ALREADY_EXISTS', `Session ${body.name} already exists.`);
  }
  await assertNoOverlap(parseDay(startsOnStr), parseDay(endsOnStr), id);

  const sem = body.semesters
    ? { FIRST: body.semesters.first, SECOND: body.semesters.second }
    : Object.fromEntries(s.semesters.map((x) => [x.name, { startsOn: fmtDay(x.startsOn), endsOn: fmtDay(x.endsOn) }]));
  for (const [k, v] of Object.entries(sem)) {
    if (v.startsOn < startsOnStr || v.endsOn > endsOnStr) {
      throw Errors.badRequest('SEMESTER_OUT_OF_RANGE', `The ${k === 'FIRST' ? '1st' : '2nd'} semester must sit inside the session dates.`);
    }
  }
  if (sem.FIRST && sem.SECOND && sem.FIRST.endsOn >= sem.SECOND.startsOn) {
    throw Errors.badRequest('SEMESTER_ORDER', 'The 1st semester must end before the 2nd semester starts.');
  }
  const actor = actorFrom(req, res);

  await prisma.$transaction(async (tx) => {
    await tx.academicSession.update({ where: { id }, data: { name: body.name, startsOn: parseDay(startsOnStr), endsOn: parseDay(endsOnStr) } });
    if (body.semesters) {
      for (const [name, v] of [['FIRST', body.semesters.first], ['SECOND', body.semesters.second]] as const) {
        const data = { startsOn: parseDay(v.startsOn), endsOn: parseDay(v.endsOn) };
        await tx.semester.upsert({ where: { sessionId_name: { sessionId: id, name } }, create: { sessionId: id, name, ...data }, update: data });
      }
    }
    await writeAudit(tx, actor, {
      action: 'session.update', targetType: 'AcademicSession', targetId: id,
      before: { name: s.name, startsOn: fmtDay(s.startsOn), endsOn: fmtDay(s.endsOn), semesters: s.semesters.map((x) => ({ name: x.name, startsOn: fmtDay(x.startsOn), endsOn: fmtDay(x.endsOn) })) },
      after: { name: body.name ?? s.name, startsOn: startsOnStr, endsOn: endsOnStr, semesters: body.semesters },
    });
  });
  res.json({ data: (await loadSessions({ id }))[0] });
};

export const activateSession = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const s = await prisma.academicSession.findUnique({ where: { id } });
  if (!s) throw Errors.notFound('Session');
  if (s.closedAt) throw Errors.conflict('SESSION_CLOSED', 'A closed session cannot be made current.');
  const actor = actorFrom(req, res);
  await prisma.$transaction(async (tx) => {
    await tx.academicSession.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    await tx.academicSession.update({ where: { id }, data: { isCurrent: true } });
    await writeAudit(tx, actor, { action: 'session.activate', targetType: 'AcademicSession', targetId: id, after: { name: s.name } });
  });
  res.json({ data: (await loadSessions({ id }))[0] });
};

export const closeSession = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const s = await prisma.academicSession.findUnique({ where: { id } });
  if (!s) throw Errors.notFound('Session');
  if (s.closedAt) throw Errors.conflict('SESSION_CLOSED', 'This session is already closed.');
  const open = await prisma.sitting.count({ where: { status: 'OPEN', exam: { sessionId: id } } });
  if (open) throw Errors.conflict('EXAMS_IN_PROGRESS', `${open} exam sitting(s) are open right now. Close them before closing the session.`);
  const actor = actorFrom(req, res);

  const promoted = await prisma.$transaction(async (tx) => {
    await tx.academicSession.update({ where: { id }, data: { closedAt: new Date(), isCurrent: false } });
    let next: { id: string; name: string } | null = null;
    if (s.isCurrent) {
      next = await tx.academicSession.findFirst({
        where: { id: { not: id }, closedAt: null, startsOn: { gt: s.startsOn } },
        orderBy: { startsOn: 'asc' }, select: { id: true, name: true },
      });
      if (next) await tx.academicSession.update({ where: { id: next.id }, data: { isCurrent: true } });
    }
    await writeAudit(tx, actor, { action: 'session.close', targetType: 'AcademicSession', targetId: id, after: { name: s.name, promoted: next?.name ?? null } });
    return next;
  });
  res.json({ data: (await loadSessions({ id }))[0], meta: { promoted } });
};

export const deleteSession = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const s = await prisma.academicSession.findUnique({ where: { id } });
  if (!s) throw Errors.notFound('Session');
  if (s.isCurrent) throw Errors.conflict('IN_USE', 'You can’t delete the current session.');
  const actor = actorFrom(req, res);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.semester.deleteMany({ where: { sessionId: id } });
      await tx.academicSession.delete({ where: { id } });
      await writeAudit(tx, actor, { action: 'session.delete', targetType: 'AcademicSession', targetId: id, before: { name: s.name } });
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2003') throw Errors.conflict('IN_USE', 'This session already has exams, enrolments or assignments.');
    throw e;
  }
  res.status(204).end();
};

export const sessionSummary = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  if (!(await prisma.academicSession.findUnique({ where: { id }, select: { id: true } }))) throw Errors.notFound('Session');
  const [exams, sittings, attempts, results] = await Promise.all([
    prisma.exam.count({ where: { sessionId: id } }),
    prisma.sitting.count({ where: { exam: { sessionId: id } } }),
    prisma.attempt.count({ where: { sitting: { exam: { sessionId: id } }, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } } }),
    prisma.result.aggregate({ where: { isCurrent: true, attempt: { sitting: { exam: { sessionId: id } } } }, _avg: { percent: true }, _count: true }),
  ]);
  res.json({ data: { exams, sittings, attempts, results: results._count, avgPercent: results._avg.percent ? Number(results._avg.percent) : null } });
};