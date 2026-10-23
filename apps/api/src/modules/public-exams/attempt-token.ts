import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { Errors } from '../../lib/errors';

/**
 * Anonymous public candidates never get an AuthSession or a role, so they
 * cannot use requireAuth. This scoped token only grants access to one attempt.
 */
export interface AttemptTokenPayload {
  kind: 'PUBLIC_ATTEMPT';
  attemptId: string;
  sub: string;
}

export function signAttemptToken(attemptId: string, studentId: string, expiresInSec: number) {
  const payload: AttemptTokenPayload = { kind: 'PUBLIC_ATTEMPT', attemptId, sub: studentId };
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: Math.max(60, Math.floor(expiresInSec)),
  });
}

export function verifyAttemptToken(token: string): AttemptTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    }) as Partial<AttemptTokenPayload>;
    if (payload.kind !== 'PUBLIC_ATTEMPT' || !payload.attemptId || !payload.sub) {
      throw Errors.forbidden();
    }
    return payload as AttemptTokenPayload;
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      throw Errors.tokenExpired();
    }
    if (error instanceof Error && error.name === 'JsonWebTokenError') {
      throw Errors.forbidden();
    }
    throw error;
  }
}

export function bearerToken(header: string | undefined): string {
  if (!header || !header.startsWith('Bearer ')) {
    throw Errors.forbidden();
  }
  return header.slice('Bearer '.length).trim();
}
