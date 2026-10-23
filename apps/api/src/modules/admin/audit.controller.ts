import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { pageMeta, pageShape, sendCsv, toCsv, blankToUndef, dateOnly } from '../../lib/http';
import { actorFrom, targetLabel, verifyChain, writeAudit } from '../../lib/audit';

const CATEGORY_VERBS = {
  Create: ['create', 'import'],
  Delete: ['delete'],
  Login: ['login', 'logout'],
  Intervention: ['pause', 'resume', 'extend', 'reset_session', 'end', 'message'],
} as const;
const CATEGORIES = ['Create', 'Edit', 'Delete', 'Login', 'Intervention'] as const;

export const categoryOf = (action: string): (typeof CATEGORIES)[number] => {
  const verb = action.split('.').pop() ?? '';
  for (const [cat, verbs] of Object.entries(CATEGORY_VERBS)) if ((verbs as readonly string[]).includes(verb)) return cat as never;
  return 'Edit';
};
const verbClauses = (verbs: readonly string[]): Prisma.AuditLogWhereInput[] => verbs.map((v) => ({ action: { endsWith: `.${v}` } }));

const opt = <T extends z.ZodType>(s: T) => z.preprocess(blankToUndef, s.optional());
const query = z.object({
  ...pageShape,
  search: opt(z.string().trim().max(100)),
  role: opt(z.string().trim().max(30)),
  category: opt(z.enum(CATEGORIES)),
  from: opt(dateOnly),
  to: opt(dateOnly),
});

function whereFrom(q: z.infer<typeof query>): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (q.search) {
    const c = { contains: q.search, mode: 'insensitive' as const };
    and.push({ OR: [{ requestId: c }, { action: c }, { targetType: c }, { targetId: c }, { ip: c }, { userAgent: c }, { actor: { names: c } }] });
  }
  if (q.role) and.push({ actorRole: q.role });
  if (q.category) {
    and.push(q.category === 'Edit'
      ? { NOT: Object.values(CATEGORY_VERBS).flatMap((v) => verbClauses(v)) }
      : { OR: verbClauses(CATEGORY_VERBS[q.category]) });
  }
  // Calendar days are Africa/Lagos (UTC+1)
  if (q.from) and.push({ at: { gte: new Date(`${q.from}T00:00:00.000+01:00`) } });
  if (q.to) and.push({ at: { lte: new Date(`${q.to}T23:59:59.999+01:00`) } });
  return and.length ? { AND: and } : {};
}

const present = (r: Prisma.AuditLogGetPayload<{ include: { actor: { select: { names: true } } } }>) => ({
  id: r.id.toString(), requestId: r.requestId, at: r.at, actorId: r.actorId, actorName: r.actor.names,
  actorRole: r.actorRole, action: r.action, category: categoryOf(r.action), targetType: r.targetType,
  targetId: r.targetId, targetLabel: targetLabel(r.before, r.after), before: r.before, after: r.after,
  ip: r.ip, userAgent: r.userAgent,
});

export const listAudit = async (req: Request, res: Response) => {
  const q = query.parse(req.query);
  const where = whereFrom(q);
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      include: { actor: { select: { names: true } } },
    }),
  ]);
  res.json({ data: rows.map(present), meta: pageMeta(q.page, q.pageSize, total) });
};

export const exportAudit = async (req: Request, res: Response) => {
  const q = query.parse(req.query);
  const rows = await prisma.auditLog.findMany({
    where: whereFrom(q), orderBy: { id: 'desc' }, take: 10000, include: { actor: { select: { names: true } } },
  });
  await prisma.$transaction((tx) => writeAudit(tx, actorFrom(req, res), { action: 'audit.export', targetType: 'AuditLog', targetId: 'bulk', after: { count: rows.length } }));
  sendCsv(
    res,
    `LASUSTECH_Audit_${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(
      ['Request ID', 'Time (UTC)', 'User', 'Role', 'Action', 'Target', 'Target ID', 'IP', 'Device'],
      rows.map((r) => [r.requestId, r.at, r.actor.names, r.actorRole, r.action, r.targetType, r.targetId, r.ip, r.userAgent]),
    ),
  );
};

export const verifyAudit = async (req: Request, res: Response) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(10).max(20000).default(2000) }).parse(req.query);
  res.json({ data: await verifyChain(limit) });
};