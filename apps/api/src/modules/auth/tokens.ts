import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

/**
 * The institution has exactly three roles, at every layer: database rows,
 * API payloads, dashboards and documentation.
 *
 * Exam-office and invigilation duties are capabilities of these roles, not
 * separate identities:
 *   * scheduling, publishing and oversight of papers → ADMIN
 *   * authoring, moderation and live invigilation of own papers → LECTURER
 *   * sitting papers → STUDENT
 *
 * Keep this list in step with `packages/db/src/seed.ts` (ROLES) and
 * `lasustech-cbt/lib/roles.ts` (ROLE_KEYS).
 */
export type RoleKey = 'ADMIN' | 'LECTURER' | 'STUDENT';

export const ROLE_KEYS: readonly RoleKey[] = ['ADMIN', 'LECTURER', 'STUDENT'];

// Used to choose the dashboard when someone holds several roles.
export const ROLE_PRIORITY: RoleKey[] = ['ADMIN', 'LECTURER', 'STUDENT'];

/** The three sign-in entrances. */
export type Portal = 'admin' | 'lecturer' | 'student';

export const PORTAL_ROLE: Record<Portal, RoleKey> = {
  admin: 'ADMIN',
  lecturer: 'LECTURER',
  student: 'STUDENT',
};

export const PORTALS = Object.keys(PORTAL_ROLE) as Portal[];

export interface AccessPayload { sub: string; sid: string; roles: RoleKey[] }

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export function signAccessToken(p: AccessPayload, expiresIn: string | number = '8h') {
  return jwt.sign(p, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: expiresIn as any });
}

export function verifyAccessToken(token: string): AccessPayload {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as unknown as AccessPayload;
}

// Refresh token = "<sessionId>.<random secret>". Only sha256(secret) is stored.
export function newRefreshToken(sessionId: string) {
  const secret = crypto.randomBytes(32).toString('hex');
  return { token: `${sessionId}.${secret}`, hash: sha256(secret) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRefreshToken(raw: string | undefined) {
  if (!raw) return null;
  const i = raw.indexOf('.');
  if (i < 1) return null;
  const sessionId = raw.slice(0, i);
  if (!UUID.test(sessionId)) return null;
  return { sessionId, secret: raw.slice(i + 1) };
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
