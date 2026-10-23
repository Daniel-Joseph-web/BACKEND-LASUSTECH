import crypto from 'crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from './prisma';
import { ROLE_PRIORITY } from '../modules/auth/tokens';

export type Tx = Prisma.TransactionClient;

export interface AuditActor {
  actorId: string;
  actorRole: string;
  ip: string;
  userAgent: string;
  requestId: string;
}
export interface AuditEntry {
  action: string; // convention: "entity.verb", e.g. "user.create"
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
}

// jsonb reorders keys, so hash a canonical form
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

const normalize = (v: unknown): unknown =>
  v === undefined || v === null ? null : JSON.parse(JSON.stringify(v));

interface Hashable {
  prevHash: string;
  at: Date;
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  before: unknown;
  after: unknown;
  ip: string;
  requestId: string;
}

export const computeHash = (h: Hashable) =>
  crypto
    .createHash('sha256')
    .update(
      stableStringify([
        h.prevHash, h.at.toISOString(), h.actorId, h.actorRole, h.action,
        h.targetType, h.targetId, normalize(h.before), normalize(h.after), h.ip, h.requestId,
      ]),
    )
    .digest('hex');

export function actorFrom(req: Request, res: Response): AuditActor {
  const roles = req.auth?.roles ?? [];
  return {
    actorId: req.auth!.userId,
    actorRole: ROLE_PRIORITY.find((r) => roles.includes(r)) ?? 'UNKNOWN',
    ip: req.ip || 'unknown',
    userAgent: (req.get('user-agent') || 'unknown').slice(0, 300),
    requestId: String(res.locals.requestId ?? crypto.randomUUID()),
  };
}

/** Must run inside a transaction: the advisory lock serialises the chain. */
export async function writeAudit(tx: Tx, actor: AuditActor, e: AuditEntry) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(727001)`;
  const last = await tx.auditLog.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
  const prevHash = last?.hash ?? 'GENESIS';
  const at = new Date();
  const before = normalize(e.before);
  const after = normalize(e.after);
  const hash = computeHash({
    prevHash, at, ...actor,
    action: e.action, targetType: e.targetType, targetId: e.targetId, before, after,
  });
  await tx.auditLog.create({
    data: {
      at,
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      before: before === null ? undefined : (before as Prisma.InputJsonValue),
      after: after === null ? undefined : (after as Prisma.InputJsonValue),
      ip: actor.ip,
      userAgent: actor.userAgent,
      requestId: actor.requestId,
      prevHash,
      hash,
    },
  });
}

export const auditOne = (actor: AuditActor, e: AuditEntry) =>
  prisma.$transaction((tx) => writeAudit(tx, actor, e));

/** Re-computes the last `limit` hashes and checks the links between them. */
export async function verifyChain(limit: number) {
  const rows = (await prisma.auditLog.findMany({ orderBy: { id: 'desc' }, take: limit })).reverse();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expected = computeHash({
      prevHash: r.prevHash, at: r.at, actorId: r.actorId, actorRole: r.actorRole, action: r.action,
      targetType: r.targetType, targetId: r.targetId, before: r.before, after: r.after,
      ip: r.ip, requestId: r.requestId,
    });
    if (expected !== r.hash) return { ok: false, checked: i + 1, brokenAt: r.id.toString(), reason: 'Entry contents were altered.' };
    if (i > 0 && r.prevHash !== rows[i - 1].hash) return { ok: false, checked: i + 1, brokenAt: r.id.toString(), reason: 'An entry before this one was removed or reordered.' };
  }
  return { ok: true, checked: rows.length, brokenAt: null, reason: null };
}

export function targetLabel(before: unknown, after: unknown): string | null {
  const o = (after ?? before) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  for (const k of ['names', 'name', 'title', 'code']) if (typeof o[k] === 'string') return o[k] as string;
  return null;
}