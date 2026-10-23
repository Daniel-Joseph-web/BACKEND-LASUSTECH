import bcrypt from 'bcryptjs';
import crypto from 'crypto';

import { prisma } from '../../lib/prisma';
import { AppError, Errors } from '../../lib/errors';
import { getGroup } from '../../lib/settings';
import {
  Portal,
  PORTAL_ROLE,
  RoleKey,
  ROLE_PRIORITY,
  sha256,
  signAccessToken,
  newRefreshToken,
  parseRefreshToken,
  safeEqual,
} from './tokens';

const SESSION_MS = 8 * 60 * 60 * 1000;

interface RotatedGraceEntry {
  response: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    user: any;
  };
  expiresAtMs: number;
}
const rotationGraceCache = new Map<string, RotatedGraceEntry>();

function purgeExpiredGrace() {
  const now = Date.now();
  for (const [k, v] of rotationGraceCache.entries()) {
    if (v.expiresAtMs <= now) rotationGraceCache.delete(k);
  }
}

// bcrypt cost factor.
// 12 is a reasonable balance between security and login performance.
const BCRYPT_ROUNDS = 12;

// Verified when the account doesn't exist, so response time
// doesn't reveal whether an account exists.
let dummyHash: Promise<string> | undefined;

const getDummyHash = () =>
  (dummyHash ??= bcrypt.hash('not-a-real-password', BCRYPT_ROUNDS));

interface Ctx {
  ip: string;
  userAgent: string;
}

type UserWithRoles = {
  roles: { scopeType: string; role: { key: string } }[];
};

// Single typed place to turn Prisma's role join rows into RoleKey[].
//
// Only GLOBAL grants count as institutional authority. A row scoped to a
// college, department or course is not a licence to enter the global portal —
// the database gatekeeper (app_set_roles) only ever writes GLOBAL grants, so
// honouring a narrower one as global would be an over-grant.
function extractRoles(u: UserWithRoles): RoleKey[] {
  return [
    ...new Set<RoleKey>(
      u.roles
        .filter((r) => r.scopeType === 'GLOBAL')
        .map((r) => r.role.key as RoleKey),
    ),
  ];
}

function toUser(
  u: { id: string; names: string },
  roles: RoleKey[],
) {
  const primaryRole = ROLE_PRIORITY.find((r) => roles.includes(r))!;

  return {
    id: u.id,
    names: u.names,
    roles,
    primaryRole,
  };
}

export class AuthService {
  async login(
    identifier: string,
    password: string,
    ctx: Ctx,
    portal?: Portal,
  ) {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          {
            email: {
              equals: identifier,
              mode: 'insensitive',
            },
          },
          {
            matricNo: {
              equals: identifier,
              mode: 'insensitive',
            },
          },
          {
            staffId: {
              equals: identifier,
              mode: 'insensitive',
            },
          },
        ],
      },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    // Always perform a bcrypt comparison even when the
    // account doesn't exist to reduce timing differences.
    if (!user || !user.passwordHash) {
      await bcrypt
        .compare(password, await getDummyHash())
        .catch(() => false);

      throw Errors.invalidCredentials();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw Errors.locked(
        Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000),
      );
    }

    const ok = await bcrypt
      .compare(password, user.passwordHash)
      .catch(() => false);

    if (!ok) {
      const sec = await getGroup('security');
      const lockMs = sec.lockoutDurationMins * 60 * 1000;
      const failures = user.failedLoginCount + 1;
      const lock = failures >= sec.maxLoginAttempts;
      await prisma.user.update({
        where: { id: user.id },
        data: lock
          ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + lockMs) }
          : { failedLoginCount: failures },
      });
      throw lock ? Errors.locked(lockMs / 1000) : Errors.invalidCredentials();
    }

    // Password is correct.
    // Now check whether the account is usable.
    if (user.status === 'LOCKED') {
      throw Errors.locked(0);
    }

    if (user.status !== 'ACTIVE') {
      // INVITED / DEACTIVATED
      throw Errors.invalidCredentials();
    }

    const roles = extractRoles(user);

    if (roles.length === 0) {
      throw Errors.forbidden();
    }

    // Three entrances, enforced before any session is created: a correct
    // password is not enough to enter a portal the account has no role for.
    // Doing it here (rather than after login) means a refused attempt leaves no
    // session behind and, for a student, does not revoke the session the
    // "one device" rule would otherwise end.
    if (portal && !roles.includes(PORTAL_ROLE[portal])) {
      throw new AppError(
        403,
        'PORTAL_FORBIDDEN',
        `This account cannot sign in to the ${portal} portal.`,
      );
    }

    if (!roles.includes('ADMIN') && (await getGroup('general')).maintenanceMode) {
      throw Errors.maintenance();
    }

    const sec = await getGroup('security');

    // Single active session rule
    if (sec.enforceSingleSession || roles.includes('STUDENT')) {
      const running = await prisma.attempt.findFirst({
        where: {
          studentId: user.id,
          status: { in: ['IN_PROGRESS', 'PAUSED'] },
          sessionId: { not: null },
        },
        select: { sessionId: true },
      });

      if (running?.sessionId) {
        const owner = await prisma.authSession.findUnique({
          where: { id: running.sessionId },
        });

        if (
          owner &&
          !owner.revokedAt &&
          owner.expiresAt > new Date()
        ) {
          throw new AppError(
            409,
            'SESSION_ELSEWHERE',
            'Your exam is open on another device. Ask the invigilator to reset your session.',
          );
        }
      }

      await prisma.authSession.updateMany({
        where: {
          userId: user.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedReason: 'NEW_LOGIN',
        },
      });
    }

    const sessionId = crypto.randomUUID();
    const refresh = newRefreshToken(sessionId);
    const sessionTimeoutMs = (sec.sessionTimeoutMins || 480) * 60 * 1000;
    const expiresAt = new Date(Date.now() + sessionTimeoutMs);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      }),

      prisma.authSession.create({
        data: {
          id: sessionId,
          userId: user.id,
          familyId: crypto.randomUUID(),
          refreshTokenHash: refresh.hash,
          deviceHash: sha256(`${ctx.ip}-${ctx.userAgent}`),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          lastSeenAt: new Date(),
          expiresAt,
        },
      }),
    ]);

    return {
      accessToken: signAccessToken({
        sub: user.id,
        sid: sessionId,
        roles,
      }),
      refreshToken: refresh.token,
      expiresAt,
      user: toUser(user, roles),
    };
  }

  async refresh(rawToken: string | undefined) {
    const parsed = parseRefreshToken(rawToken);

    if (!parsed) {
      throw Errors.tokenExpired();
    }

    purgeExpiredGrace();
    const tokenSecretHash = sha256(parsed.secret);
    const inGrace = rotationGraceCache.get(tokenSecretHash);
    if (inGrace && inGrace.expiresAtMs > Date.now()) {
      return inGrace.response;
    }

    const session = await prisma.authSession.findUnique({
      where: { id: parsed.sessionId },
    });

    // Absolute session lifetime limit (7 days) or explicit revocation.
    // Refresh token renews the session even if idle expiresAt has passed.
    const maxSessionAgeMs = 7 * 24 * 60 * 60 * 1000;
    if (
      !session ||
      session.revokedAt ||
      session.createdAt.getTime() + maxSessionAgeMs <= Date.now()
    ) {
      throw Errors.tokenExpired();
    }

    // Old/stolen token presented again:
    // If not matching current hash and not in 30s grace window, revoke family.
    if (!safeEqual(session.refreshTokenHash, tokenSecretHash)) {
      await prisma.authSession.updateMany({
        where: {
          familyId: session.familyId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedReason: 'REFRESH_REUSE',
        },
      });

      throw Errors.tokenExpired();
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw Errors.tokenExpired();
    }

    const roles = extractRoles(user);

    const next = newRefreshToken(session.id);
    const sec = await getGroup('security');
    const sessionTimeoutMs = (sec.sessionTimeoutMins || 480) * 60 * 1000;
    const newExpiresAt = new Date(Date.now() + sessionTimeoutMs);

    await prisma.authSession.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: next.hash,
        expiresAt: newExpiresAt,
        lastSeenAt: new Date(),
      },
    });

    const result = {
      accessToken: signAccessToken({
        sub: user.id,
        sid: session.id,
        roles,
      }),
      refreshToken: next.token,
      expiresAt: newExpiresAt,
      user: toUser(user, roles),
    };

    // Store in grace cache for 30s to allow in-flight concurrent requests to succeed
    rotationGraceCache.set(tokenSecretHash, {
      response: result,
      expiresAtMs: Date.now() + 30_000,
    });

    return result;
  }

  async logout(rawToken: string | undefined) {
    const parsed = parseRefreshToken(rawToken);

    if (!parsed) {
      return;
    }

    await prisma.authSession.updateMany({
      where: {
        id: parsed.sessionId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
        revokedReason: 'LOGOUT',
      },
    });
  }

  async me(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      throw Errors.tokenExpired();
    }

    const roles = extractRoles(user);

    return {
      ...toUser(user, roles),
      email: user.email,
      matricNo: user.matricNo,
      staffId: user.staffId,
    };
  }
}