import { NextFunction, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { fmtDay, LAGOS_OFFSET_MS, todayLagos } from '../../lib/http';
import { targetLabel } from '../../lib/audit';
import { env } from '../../config/env';

const DAYS = 30;
const DAY_MS = 86_400_000;

export const getDashboard = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const today = todayLagos(); // UTC midnight representing today's Lagos date
    const firstDay = new Date(today.getTime() - (DAYS - 1) * DAY_MS);
    const since = new Date(firstDay.getTime() - LAGOS_OFFSET_MS); // Lagos midnight in UTC
    const dayStart = new Date(today.getTime() - LAGOS_OFFSET_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const d7 = new Date(now.getTime() - 7 * DAY_MS);
    const d14 = new Date(now.getTime() - 14 * DAY_MS);

    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbMs = Date.now() - t0;

    // Split queries into smaller batches to prevent connection pool exhaustion on Windows
    const [loginRows, examRows] = await Promise.all([
      prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(timezone('Africa/Lagos', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
        FROM auth_sessions WHERE created_at >= ${since} GROUP BY 1`,
      prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(timezone('Africa/Lagos', starts_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS n
        FROM sittings WHERE starts_at >= ${since} AND status::text <> 'CANCELLED' GROUP BY 1`,
    ]);

    const [active, previous] = await Promise.all([
      prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT user_id)::int AS n FROM auth_sessions WHERE created_at >= ${d7}`,
      prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT user_id)::int AS n FROM auth_sessions WHERE created_at >= ${d14} AND created_at < ${d7}`,
    ]);

    const [examsToday, examsLive, alerts, alertsHigh, recent, activeExamsList] = await Promise.all([
      prisma.sitting.count({ where: { startsAt: { gte: dayStart, lt: dayEnd }, status: { not: 'CANCELLED' } } }),
      prisma.sitting.count({ where: { status: 'OPEN' } }),
      prisma.flag.count({ where: { reviewedAt: null } }),
      prisma.flag.count({ where: { reviewedAt: null, severity: 'HIGH' } }),
      prisma.auditLog.findMany({ take: 8, orderBy: { id: 'desc' }, include: { actor: { select: { names: true } } } }),
      prisma.exam.findMany({
        where: {
          OR: [
            { audience: 'PUBLIC' },
            { sittings: { some: { status: { in: ['OPEN', 'SCHEDULED'] } } } },
          ],
        },
        take: 15,
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
        include: {
          course: { select: { code: true, title: true } },
          subject: { select: { name: true, code: true } },
          sittings: {
            select: {
              id: true,
              startsAt: true,
              endsAt: true,
              status: true,
              venue: true,
              durationMin: true,
              requireWebcam: true,
              isPublic: true,
            },
            orderBy: { startsAt: 'desc' },
            take: 1,
          },
          sections: { select: { _count: { select: { questions: true } } } },
        },
      }),
    ]);

    const origin = (env.WEB_ORIGIN || '').replace(/\/$/, '');
    const activeExams = activeExamsList.map((exam) => {
      const sitting = exam.sittings[0] ?? null;
      const settingsObj = ((exam.settings ?? {}) as Record<string, any>);
      const code = (settingsObj.accessCode as string | undefined) ?? null;
      const slug = exam.publicSlug || exam.id;
      const publicLink = (exam.audience === 'PUBLIC' || sitting?.isPublic) ? `/exam/${slug}` : null;
      const publicUrl = publicLink ? (origin ? `${origin}${publicLink}` : publicLink) : null;
      const totalQuestions = exam.sections.reduce((sum, s) => sum + s._count.questions, 0);

      return {
        id: exam.id,
        title: exam.title,
        courseCode: exam.course?.code ?? exam.subject?.code ?? 'EXAM',
        courseTitle: exam.course?.title ?? exam.subject?.name ?? exam.title,
        audience: exam.audience,
        status: sitting?.status ?? exam.status,
        durationMin: exam.durationMin ?? sitting?.durationMin ?? 60,
        passMark: exam.passMark ? Number(exam.passMark) : null,
        questionCount: totalQuestions,
        sittingId: sitting?.id ?? null,
        startsAt: sitting?.startsAt ? sitting.startsAt.toISOString() : exam.publicOpensAt?.toISOString() ?? null,
        endsAt: sitting?.endsAt ? sitting.endsAt.toISOString() : exam.publicClosesAt?.toISOString() ?? null,
        venue: sitting?.venue ?? null,
        requireWebcam: sitting?.requireWebcam ?? false,
        accessCode: code,
        publicSlug: exam.publicSlug,
        publicLink,
        publicUrl,
      };
    });

    const logins = new Map(loginRows.map((r) => [r.day, r.n]));
    const exams = new Map(examRows.map((r) => [r.day, r.n]));
    const series = Array.from({ length: DAYS }, (_, i) => {
      const date = fmtDay(new Date(firstDay.getTime() + i * DAY_MS));
      return { date, logins: logins.get(date) ?? 0, exams: exams.get(date) ?? 0 };
    });

    res.json({
      data: {
        stats: {
          activeUsers: { value: active[0]?.n ?? 0, previous: previous[0]?.n ?? 0 },
          examsToday: { total: examsToday, inProgress: examsLive },
          openAlerts: { total: alerts, high: alertsHigh },
          uptimeSeconds: Math.floor(process.uptime()),
        },
        activeExams,
        series,
        health: [
          { name: 'API', status: 'ok', latencyMs: 0 },
          { name: 'Database', status: dbMs > 500 ? 'degraded' : 'ok', latencyMs: dbMs },
          { name: 'Realtime socket', status: 'unknown', latencyMs: null },
          { name: 'File storage', status: 'unknown', latencyMs: null },
        ],
        recent: recent.map((r) => ({
          id: r.id.toString(),
          requestId: r.requestId,
          at: r.at,
          actorName: r.actor?.names ?? 'System Administrator',
          action: r.action,
          targetType: r.targetType,
          targetLabel: targetLabel(r.before, r.after),
        })),
        serverTime: now,
      },
    });
  } catch (err) {
    next(err);
  }
};
