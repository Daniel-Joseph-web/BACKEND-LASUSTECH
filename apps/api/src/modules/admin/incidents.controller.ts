import { Request, Response } from 'express';
import { z } from 'zod';
import type { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { pageMeta, pageShape, sendCsv, toCsv, uuidParam } from '../../lib/http';
import { publishRealtimeEvent } from '../../lib/realtime';

const incidentInclude = {
  reporter: { select: { id: true, names: true } },
  sitting: {
    select: {
      id: true,
      venue: true,
      startsAt: true,
      exam: {
        select: {
          title: true,
          course: { select: { code: true, title: true } },
        },
      },
    },
  },
} satisfies Prisma.IncidentInclude;

type IncidentRow = Prisma.IncidentGetPayload<{ include: typeof incidentInclude }>;

const present = (i: IncidentRow) => ({
  id: i.id,
  referenceNo: i.referenceNo,
  category: i.category,
  severity: i.severity,
  status: i.status,
  candidateName: i.candidateName,
  matricNo: i.matricNo,
  seatLabel: i.seatLabel,
  hall: i.hall,
  description: i.description,
  actionTaken: i.actionTaken,
  docketConfiscated: i.docketConfiscated,
  resolutionNote: i.resolutionNote,
  resolvedAt: i.resolvedAt,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  reportedBy: i.reportedBy,
  reporterName: i.reporter.names,
  sittingId: i.sittingId,
  attemptId: i.attemptId,
  venue: i.sitting?.venue ?? null,
  sittingStartsAt: i.sitting?.startsAt ?? null,
  courseCode: i.sitting?.exam?.course?.code ?? null,
  courseTitle: i.sitting?.exam?.course?.title ?? null,
  examTitle: i.sitting?.exam?.title ?? null,
});

const CATEGORIES = ['MALPRACTICE', 'TECHNICAL', 'INFRASTRUCTURE', 'MEDICAL', 'CONDUCT'] as const;
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const STATUSES = ['UNDER_REVIEW', 'ESCALATED', 'RESOLVED'] as const;
const STATUS_FILTERS = ['ALL', 'UNDER_REVIEW', 'ESCALATED', 'RESOLVED'] as const;
const CATEGORY_FILTERS = ['ALL', 'MALPRACTICE', 'TECHNICAL', 'INFRASTRUCTURE', 'MEDICAL', 'CONDUCT'] as const;
const SEVERITY_FILTERS = ['ALL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

const listQuery = z.object({
  ...pageShape,
  status: z.enum(STATUS_FILTERS).default('ALL'),
  category: z.enum(CATEGORY_FILTERS).default('ALL'),
  severity: z.enum(SEVERITY_FILTERS).default('ALL'),
  search: z.string().trim().max(120).optional(),
});

function buildWhere(q: z.infer<typeof listQuery>): Prisma.IncidentWhereInput {
  const where: Prisma.IncidentWhereInput = {};
  if (q.status !== 'ALL') where.status = q.status;
  if (q.category !== 'ALL') where.category = q.category;
  if (q.severity !== 'ALL') where.severity = q.severity;
  if (q.search) {
    const search = q.search;
    where.OR = [
      { referenceNo: { contains: search, mode: 'insensitive' } },
      { candidateName: { contains: search, mode: 'insensitive' } },
      { matricNo: { contains: search, mode: 'insensitive' } },
      { hall: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { sitting: { exam: { course: { code: { contains: search, mode: 'insensitive' } } } } },
    ];
  }
  return where;
}

export const listIncidents = async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query);
  const where = buildWhere(q);

  const [rows, total, open, escalated, resolved, critical] = await Promise.all([
    prisma.incident.findMany({
      where,
      include: incidentInclude,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.incident.count({ where }),
    prisma.incident.count({ where: { status: { in: ['UNDER_REVIEW', 'ESCALATED'] } } }),
    prisma.incident.count({ where: { status: 'ESCALATED' } }),
    prisma.incident.count({ where: { status: 'RESOLVED' } }),
    prisma.incident.count({ where: { severity: 'CRITICAL', status: { not: 'RESOLVED' } } }),
  ]);

  res.json({
    data: rows.map(present),
    meta: {
      ...pageMeta(q.page, q.pageSize, total),
      counts: { open, escalated, resolved, critical },
    },
  });
};

const createSchema = z.object({
  sittingId: z.uuid().optional(),
  attemptId: z.uuid().optional(),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  candidateName: z.string().trim().max(160).optional(),
  matricNo: z.string().trim().max(40).optional(),
  seatLabel: z.string().trim().max(40).optional(),
  hall: z.string().trim().max(120).optional(),
  description: z.string().trim().min(5, 'Describe what happened.').max(4000),
  actionTaken: z.string().trim().max(1000).optional(),
  docketConfiscated: z.boolean().default(false),
});

const REF_LOCK = 727002;

export const createIncident = async (req: Request, res: Response) => {
  const body = createSchema.parse(req.body);
  const actor = actorFrom(req, res);

  // Pull candidate and hall details from the attempt when the docket was filed
  // against a specific workstation/seat.
  let sittingId = body.sittingId ?? null;
  let candidateName = body.candidateName ?? null;
  let matricNo = body.matricNo ?? null;
  let seatLabel = body.seatLabel ?? null;
  let hall = body.hall ?? null;

  if (body.attemptId) {
    const attempt = await prisma.attempt.findUnique({
      where: { id: body.attemptId },
      select: {
        id: true,
        sittingId: true,
        studentId: true,
        student: { select: { names: true, matricNo: true } },
        sitting: { select: { venue: true } },
      },
    });
    if (!attempt) throw Errors.notFound('Attempt');
    if (body.sittingId && body.sittingId !== attempt.sittingId) {
      throw Errors.badRequest('ATTEMPT_MISMATCH', 'That attempt does not belong to the chosen sitting.');
    }
    sittingId = attempt.sittingId;
    candidateName ??= attempt.student.names;
    matricNo ??= attempt.student.matricNo;
    hall ??= attempt.sitting.venue;
    if (!seatLabel) {
      const row = await prisma.sittingStudent.findUnique({
        where: { sittingId_studentId: { sittingId: attempt.sittingId, studentId: attempt.studentId } },
        select: { seatLabel: true },
      });
      seatLabel = row?.seatLabel ?? null;
    }
  } else if (sittingId) {
    const sitting = await prisma.sitting.findUnique({
      where: { id: sittingId },
      select: { venue: true },
    });
    if (!sitting) throw Errors.notFound('Sitting');
    hall ??= sitting.venue;
  }

  const year = new Date().getFullYear();
  const prefix = `INC-${year}-`;

  const created = await prisma.$transaction(async (tx) => {
    // Serialise reference allocation so two concurrent dockets cannot take the
    // same number.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REF_LOCK}::bigint)`;
    const latest = await tx.incident.findFirst({
      where: { referenceNo: { startsWith: prefix } },
      orderBy: { referenceNo: 'desc' },
      select: { referenceNo: true },
    });
    const next = latest ? Number(latest.referenceNo.slice(prefix.length)) + 1 : 1;
    const referenceNo = `${prefix}${String(next).padStart(3, '0')}`;

    const incident = await tx.incident.create({
      data: {
        referenceNo,
        sittingId,
        attemptId: body.attemptId ?? null,
        reportedBy: actor.actorId,
        category: body.category,
        severity: body.severity,
        candidateName,
        matricNo,
        seatLabel,
        hall,
        description: body.description,
        actionTaken: body.actionTaken ?? null,
        docketConfiscated: body.docketConfiscated,
      },
      include: incidentInclude,
    });

    await writeAudit(tx, actor, {
      action: 'incident.create',
      targetType: 'Incident',
      targetId: incident.id,
      after: {
        referenceNo: incident.referenceNo,
        category: incident.category,
        severity: incident.severity,
        candidateName,
        matricNo,
        sittingId,
      },
    });
    return incident;
  });

  if (sittingId) {
    void publishRealtimeEvent({
      event: 'incident.created',
      target: {
        rooms: [`sitting:${sittingId}`],
        roles: ['ADMIN'],
      },
      data: {
        incidentId: created.id,
        referenceNo: created.referenceNo,
        sittingId,
        attemptId: created.attemptId,
        category: created.category,
        severity: created.severity,
        candidateName: created.candidateName,
        matricNo: created.matricNo,
        seatLabel: created.seatLabel,
        description: created.description,
        createdAt: created.createdAt.toISOString(),
      },
    });
  }

  res.status(201).json({ data: present(created) });
};

const updateSchema = z
  .object({
    status: z.enum(STATUSES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    resolutionNote: z.string().trim().max(2000).optional(),
    actionTaken: z.string().trim().max(1000).optional(),
    docketConfiscated: z.boolean().optional(),
    holdResult: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to update.',
  });

export const updateIncident = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = updateSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const before = await prisma.incident.findUnique({ where: { id } });
  if (!before) throw Errors.notFound('Incident');

  const resolvedAt =
    body.status === 'RESOLVED' ? (before.resolvedAt ?? new Date()) : body.status ? null : undefined;

  const updated = await prisma.$transaction(async (tx) => {
    if (before.attemptId) {
      if (body.holdResult || body.actionTaken === 'HOLD_RESULT' || body.actionTaken === 'RESULT_HELD') {
        await tx.flag.create({
          data: {
            attemptId: before.attemptId,
            ruleKey: 'MALPRACTICE_HELD',
            severity: 'HIGH',
            details: {
              incidentId: before.id,
              referenceNo: before.referenceNo,
              reason: body.resolutionNote || 'Malpractice confirmed upon incident review',
              heldBy: actor.actorId,
              heldAt: new Date().toISOString(),
            },
          },
        }).catch(() => {});
      } else if (body.actionTaken === 'EXONERATED' || body.actionTaken === 'CLEARED') {
        await tx.flag.deleteMany({
          where: {
            attemptId: before.attemptId,
            ruleKey: 'MALPRACTICE_HELD',
          },
        }).catch(() => {});
      }
    }

    const incident = await tx.incident.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.severity ? { severity: body.severity } : {}),
        ...(body.resolutionNote !== undefined ? { resolutionNote: body.resolutionNote } : {}),
        ...(body.actionTaken !== undefined ? { actionTaken: body.actionTaken } : {}),
        ...(body.docketConfiscated !== undefined ? { docketConfiscated: body.docketConfiscated } : {}),
        ...(resolvedAt !== undefined ? { resolvedAt } : {}),
      },
      include: incidentInclude,
    });

    await writeAudit(tx, actor, {
      action: 'incident.update',
      targetType: 'Incident',
      targetId: id,
      before: {
        status: before.status,
        severity: before.severity,
        actionTaken: before.actionTaken,
        resolutionNote: before.resolutionNote,
        docketConfiscated: before.docketConfiscated,
      },
      after: {
        status: incident.status,
        severity: incident.severity,
        actionTaken: incident.actionTaken,
        resolutionNote: incident.resolutionNote,
        docketConfiscated: incident.docketConfiscated,
        resolvedAt: incident.resolvedAt,
      },
    });
    return incident;
  });

  res.json({ data: present(updated) });
};

export const exportIncidents = async (req: Request, res: Response) => {
  const q = listQuery.parse({ ...req.query, page: 1, pageSize: 100 });
  const rows = await prisma.incident.findMany({
    where: buildWhere(q),
    include: incidentInclude,
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });

  const header = [
    'Reference', 'Filed At', 'Status', 'Category', 'Severity', 'Candidate', 'Matric No',
    'Seat', 'Hall', 'Course', 'Exam', 'Description', 'Action Taken', 'Docket Confiscated',
    'Resolution', 'Resolved At', 'Reported By',
  ];
  const data = rows.map((i) => {
    const row = present(i);
    return [
      row.referenceNo,
      row.createdAt.toISOString(),
      row.status,
      row.category,
      row.severity,
      row.candidateName ?? '',
      row.matricNo ?? '',
      row.seatLabel ?? '',
      row.hall ?? '',
      row.courseCode ?? '',
      row.examTitle ?? '',
      row.description,
      row.actionTaken ?? '',
      row.docketConfiscated ? 'Yes' : 'No',
      row.resolutionNote ?? '',
      row.resolvedAt?.toISOString() ?? '',
      row.reporterName,
    ];
  });

  sendCsv(res, `incidents-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(header, data));
};
