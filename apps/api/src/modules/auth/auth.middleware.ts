import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { getGroup } from '../../lib/settings';
import { RoleKey, verifyAccessToken } from './tokens';

declare global {
  namespace Express {
    interface Request { auth?: { userId: string; sessionId: string; roles: RoleKey[] } }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw Errors.tokenExpired();

  let payload;
  try { payload = verifyAccessToken(header.slice(7)); }
  catch { throw Errors.tokenExpired(); }

  // DB check so logout takes effect immediately.
  // Move this to a Redis denylist keyed by sid once Redis is in (spec 5.2).
  //
  // The role list is deliberately re-read here rather than trusted from the
  // token. A 15-minute access token would otherwise keep a role the person no
  // longer holds, and a token minted before a demotion would still open the
  // old portal. The signed `roles` claim is only a hint; the database is the
  // authority.
  const session = await prisma.authSession.findUnique({
    where: { id: payload.sid },
    select: {
      userId: true,
      revokedAt: true,
      expiresAt: true,
      lastSeenAt: true,
      user: {
        select: {
          status: true,
          roles: { select: { scopeType: true, role: { select: { key: true } } } },
        },
      },
    },
  });
  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now) throw Errors.tokenExpired();
  if (session.userId !== payload.sub) throw Errors.tokenExpired();
  if (session.user.status !== 'ACTIVE') throw Errors.forbidden();

  // Sliding idle expiration: If active and at least 30 seconds since last activity,
  // extend expiresAt so active users are never logged out in the middle of working.
  if (now.getTime() - session.lastSeenAt.getTime() > 30_000) {
    getGroup('security')
      .then((sec) => {
        const timeoutMs = (sec.sessionTimeoutMins || 480) * 60 * 1000;
        return prisma.authSession.update({
          where: { id: payload.sid },
          data: {
            lastSeenAt: now,
            expiresAt: new Date(now.getTime() + timeoutMs),
          },
        });
      })
      .catch(() => {});
  }

  // Only GLOBAL grants count; see extractRoles() in auth.service.ts.
  const roles = [
    ...new Set(
      session.user.roles
        .filter((r) => r.scopeType === 'GLOBAL')
        .map((r) => r.role.key),
    ),
  ] as RoleKey[];
  if (roles.length === 0) throw Errors.forbidden();

  // Maintenance mode: only administrators get through.
  if (!roles.includes('ADMIN') && (await getGroup('general')).maintenanceMode) {
    throw Errors.maintenance();
  }

  req.auth = { userId: payload.sub, sessionId: payload.sid, roles };
  next();
}

// Deny by default: caller must hold at least one of the listed roles.
export const requireRole = (...allowed: RoleKey[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth?.roles.some((r) => allowed.includes(r))) throw Errors.forbidden();
    next();
  };
