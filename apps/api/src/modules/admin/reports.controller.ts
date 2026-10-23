import { Request, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { fmtDay, sendCsv, toCsv } from '../../lib/http';

const currentSessionId = async () => {
  const current = await prisma.academicSession.findFirst({
    where: { isCurrent: true },
    select: { id: true, name: true },
  });
  return current;
};

async function resolveSession(sessionId?: string) {
  if (sessionId) {
    const session = await prisma.academicSession.findUnique({
      where: { id: sessionId },
      select: { id: true, name: true },
    });
    if (!session) throw Errors.notFound('Session');
    return session;
  }
  return currentSessionId();
}

const broadsheetQuery = z.object({
  departmentId: z.uuid(),
  level: z.coerce.number().int().min(100).max(700).optional(),
  sessionId: z.uuid().optional(),
});

/**
 * Senate broadsheet: one row per student, one column pair per course, built
 * from the current (is_current) result of each attempt in the session.
 */
export const broadsheet = async (req: Request, res: Response) => {
  const q = broadsheetQuery.parse(req.query);
  const session = await resolveSession(q.sessionId);

  const profileWhere: Prisma.StudentProfileWhereInput = {
    programme: { departmentId: q.departmentId },
    ...(q.level ? { level: q.level } : {}),
  };

  const [students, courses, results] = await Promise.all([
    prisma.user.findMany({
      where: { profile: profileWhere },
      select: {
        id: true,
        names: true,
        matricNo: true,
        profile: {
          select: {
            level: true,
            programme: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: { matricNo: 'asc' },
    }),
    prisma.course.findMany({
      where: {
        departmentId: q.departmentId,
        ...(q.level ? { level: q.level } : {}),
        ...(session
          ? { exams: { some: { sessionId: session.id } } }
          : {}),
      },
      select: { id: true, code: true, title: true },
      orderBy: { code: 'asc' },
    }),
    session
      ? prisma.result.findMany({
          where: {
            isCurrent: true,
            attempt: {
              sitting: { exam: { sessionId: session.id, course: { departmentId: q.departmentId } } },
              ...(q.level ? { student: { profile: { level: q.level } } } : {}),
            },
          },
          select: {
            percent: true,
            grade: true,
            attempt: {
              select: {
                studentId: true,
                sitting: { select: { exam: { select: { courseId: true } } } },
              },
            },
          },
        })
      : [],
  ]);

  const byStudent = new Map<string, Map<string, { percent: number; grade: string }>>();
  for (const r of results) {
    const courseId = r.attempt.sitting?.exam?.courseId;
    if (!courseId) continue;
    const row = byStudent.get(r.attempt.studentId) ?? new Map();
    row.set(courseId, { percent: Number(r.percent), grade: r.grade });
    byStudent.set(r.attempt.studentId, row);
  }

  const header = [
    'Matric No',
    'Student Name',
    'Level',
    'Programme',
    ...courses.flatMap((c) => [`${c.code} Score (%)`, `${c.code} Grade`]),
  ];
  const rows = students.map((s) => {
    const scores = byStudent.get(s.id);
    return [
      s.matricNo ?? '',
      s.names,
      s.profile?.level ?? '',
      s.profile?.programme.code ?? '',
      ...courses.flatMap((c) => {
        const hit = scores?.get(c.id);
        return [hit ? hit.percent.toFixed(2) : '', hit?.grade ?? ''];
      }),
    ];
  });

  sendCsv(res, `broadsheet-${session?.name ?? 'all'}-${fmtDay(new Date())}.csv`, toCsv(header, rows));
};

const performanceQuery = z.object({
  courseId: z.uuid(),
  sessionId: z.uuid().optional(),
});

const PASS_MARK = 40;

/** Course performance analytics as a one-row-per-course CSV summary. */
export const performance = async (req: Request, res: Response) => {
  const q = performanceQuery.parse(req.query);
  const session = await resolveSession(q.sessionId);

  const course = await prisma.course.findUnique({
    where: { id: q.courseId },
    select: { id: true, code: true, title: true, units: true, level: true },
  });
  if (!course) throw Errors.notFound('Course');

  const results = await prisma.result.findMany({
    where: {
      isCurrent: true,
      attempt: {
        sitting: {
          exam: { courseId: course.id, ...(session ? { sessionId: session.id } : {}) },
        },
      },
    },
    select: { percent: true, grade: true },
  });

  const percents = results.map((r) => Number(r.percent));
  const scripts = percents.length;
  const average = scripts ? percents.reduce((a, b) => a + b, 0) / scripts : 0;
  const passed = percents.filter((p) => p >= PASS_MARK).length;
  const gradeCount = (g: string) => results.filter((r) => r.grade === g).length;

  const header = [
    'Course Code', 'Course Title', 'Level', 'Units', 'Session', 'Scripts',
    'Average (%)', 'Highest (%)', 'Lowest (%)', 'Pass Rate (%)',
    'A', 'B', 'C', 'D', 'E', 'F',
  ];
  const row = [
    course.code,
    course.title,
    course.level,
    course.units,
    session?.name ?? 'All sessions',
    scripts,
    scripts ? average.toFixed(2) : '',
    scripts ? Math.max(...percents).toFixed(2) : '',
    scripts ? Math.min(...percents).toFixed(2) : '',
    scripts ? ((passed / scripts) * 100).toFixed(2) : '',
    ...['A', 'B', 'C', 'D', 'E', 'F'].map(gradeCount),
  ];

  sendCsv(
    res,
    `performance-${course.code.replace(/\s+/g, '-')}-${session?.name ?? 'all'}.csv`,
    toCsv(header, [row]),
  );
};

// ---------- live incident log (proctoring flags + interventions + dockets) ----------

const logQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

type LogEntry = {
  id: string;
  at: Date;
  kind: 'FLAG' | 'INTERVENTION' | 'INCIDENT';
  severity: string;
  title: string;
  detail: string;
  studentName: string | null;
  matricNo: string | null;
  courseCode: string | null;
  examTitle: string | null;
  sittingId: string | null;
  attemptId: string | null;
  actorName: string | null;
};

async function incidentLog(limit: number): Promise<LogEntry[]> {
  const [flags, interventions, incidents] = await Promise.all([
    prisma.flag.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        attempt: {
          select: {
            id: true,
            sittingId: true,
            student: { select: { names: true, matricNo: true } },
          },
        },
      },
    }),
    prisma.intervention.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor: { select: { names: true } },
        attempt: {
          select: {
            id: true,
            sittingId: true,
            student: { select: { names: true, matricNo: true } },
          },
        },
      },
    }),
    prisma.incident.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { reporter: { select: { names: true } } },
    }),
  ]);

  const sittingIds = [
    ...new Set([
      ...flags.map((f) => f.attempt.sittingId),
      ...interventions.map((i) => i.attempt.sittingId),
      ...incidents.map((i) => i.sittingId).filter((v): v is string => !!v),
    ]),
  ];

  const sittings = sittingIds.length
    ? await prisma.sitting.findMany({
        where: { id: { in: sittingIds } },
        select: {
          id: true,
          exam: { select: { title: true, course: { select: { code: true } } } },
        },
      })
    : [];
  const sittingMap = new Map(sittings.map((s) => [s.id, s]));

  const entries: LogEntry[] = [
    ...flags.map((f) => {
      const sitting = sittingMap.get(f.attempt.sittingId);
      return {
        id: `flag-${f.id}`,
        at: f.createdAt,
        kind: 'FLAG' as const,
        severity: f.severity,
        title: f.ruleKey,
        detail: f.reviewedAt ? 'Flag reviewed' : 'Flag awaiting review',
        studentName: f.attempt.student.names,
        matricNo: f.attempt.student.matricNo,
        courseCode: sitting?.exam?.course?.code ?? null,
        examTitle: sitting?.exam?.title ?? null,
        sittingId: f.attempt.sittingId,
        attemptId: f.attempt.id,
        actorName: null,
      };
    }),
    ...interventions.map((i) => {
      const sitting = sittingMap.get(i.attempt.sittingId);
      const params = (i.params ?? {}) as Record<string, unknown>;
      return {
        id: `intervention-${i.id}`,
        at: i.createdAt,
        kind: 'INTERVENTION' as const,
        severity: i.action === 'END' ? 'HIGH' : i.action === 'MESSAGE' ? 'INFO' : 'WARNING',
        title: i.action,
        detail: params.message ? String(params.message) : (i.reason ?? ''),
        studentName: i.attempt.student.names,
        matricNo: i.attempt.student.matricNo,
        courseCode: sitting?.exam?.course?.code ?? null,
        examTitle: sitting?.exam?.title ?? null,
        sittingId: i.attempt.sittingId,
        attemptId: i.attempt.id,
        actorName: i.actor.names,
      };
    }),
    ...incidents.map((i) => {
      const sitting = i.sittingId ? sittingMap.get(i.sittingId) : undefined;
      return {
        id: `incident-${i.id}`,
        at: i.createdAt,
        kind: 'INCIDENT' as const,
        severity: i.severity,
        title: `${i.referenceNo} · ${i.category}`,
        detail: i.description,
        studentName: i.candidateName,
        matricNo: i.matricNo,
        courseCode: sitting?.exam?.course?.code ?? null,
        examTitle: sitting?.exam?.title ?? null,
        sittingId: i.sittingId,
        attemptId: i.attemptId,
        actorName: i.reporter.names,
      };
    }),
  ];

  return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

export const incidentEvents = async (req: Request, res: Response) => {
  const { limit } = logQuery.parse(req.query);
  res.json({ data: await incidentLog(limit) });
};

export const exportIncidentEvents = async (req: Request, res: Response) => {
  const { limit } = logQuery.parse(req.query);
  const entries = await incidentLog(limit);
  const header = ['Time', 'Kind', 'Severity', 'Event', 'Detail', 'Student', 'Matric No', 'Course', 'Exam', 'Actor'];
  const rows = entries.map((e) => [
    e.at.toISOString(), e.kind, e.severity, e.title, e.detail,
    e.studentName ?? '', e.matricNo ?? '', e.courseCode ?? '', e.examTitle ?? '', e.actorName ?? '',
  ]);
  sendCsv(res, `incident-log-${fmtDay(new Date())}.csv`, toCsv(header, rows));
};
