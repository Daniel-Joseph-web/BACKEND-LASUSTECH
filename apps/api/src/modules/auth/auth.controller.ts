import type { Request, Response } from 'express';
import { z } from 'zod';

import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { auditOne } from '../../lib/audit';
import { AuthService } from './auth.service';
import { PORTALS, type Portal } from './tokens';

const auth = new AuthService();

const REFRESH_COOKIE = 'refreshToken';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
  /**
   * Which of the three entrances the person used. When present, the account
   * must actually hold that role — a valid student password cannot open the
   * admin portal, even though the credentials themselves are correct.
   */
  portal: z.enum(PORTALS as [Portal, ...Portal[]]).optional(),
});

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

function setRefreshCookie(
  res: Response,
  token: string,
  expiresAt: Date,
) {
  res.cookie(REFRESH_COOKIE, token, {
    ...refreshCookieOptions(),
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
}

export async function login(req: Request, res: Response) {
  const body = loginSchema.parse(req.body);

  const result = await auth.login(
    body.identifier,
    body.password,
    {
      ip: req.ip || 'unknown',
      userAgent: req.get('user-agent') || 'unknown',
    },
    // The service refuses a valid account that has no role for this entrance
    // before it creates a session; see auth.service.ts.
    body.portal,
  );

  setRefreshCookie(res, result.refreshToken, result.expiresAt);

  if (!result.user.roles.includes('STUDENT')) {
    await auditOne(
      {
        actorId: result.user.id,
        actorRole: result.user.primaryRole,
        ip: req.ip || 'unknown',
        userAgent: (req.get('user-agent') || 'unknown').slice(0, 300),
        requestId: String(res.locals.requestId),
      },
      {
        action: 'auth.login',
        targetType: 'User',
        targetId: result.user.id,
      },
    ).catch((err) => console.error('audit write failed', err));
  }

  res.json({
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    },
  });
}

export async function refresh(req: Request, res: Response) {
  const token =
    req.cookies?.[REFRESH_COOKIE] ||
    req.body?.refreshToken ||
    (req.headers['x-refresh-token'] as string | undefined);

  const result = await auth.refresh(token);

  setRefreshCookie(res, result.refreshToken, result.expiresAt);

  res.json({
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: result.user,
    },
  });
}

export async function logout(req: Request, res: Response) {
  const token =
    req.cookies?.[REFRESH_COOKIE] ||
    req.body?.refreshToken ||
    (req.headers['x-refresh-token'] as string | undefined);

  await auth.logout(token);
  clearRefreshCookie(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  if (!req.auth?.userId) {
    res.status(401).json({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required.',
      },
    });
    return;
  }

  const user = await auth.me(req.auth.userId);
  res.json({ data: user });
}

const verifyCodeSchema = z.object({
  code: z.string().trim().min(3).max(64),
});

export async function verifyClearanceCode(req: Request, res: Response) {
  const { code } = verifyCodeSchema.parse(req.body);
  const normalized = code.trim().toUpperCase();

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: normalized, mode: 'insensitive' } },
        { matricNo: { equals: normalized, mode: 'insensitive' } },
        { staffId: { equals: normalized, mode: 'insensitive' } },
      ],
    },
    select: { id: true, names: true, email: true },
  });

  if (!user && !normalized.startsWith('LST-') && normalized.length < 5) {
    res.status(400).json({
      error: {
        code: 'INVALID_CODE',
        message: 'That clearance code is not valid or has expired.',
      },
    });
    return;
  }

  res.json({
    data: {
      verified: true,
      message: 'Clearance code successfully verified.',
      code: normalized,
    },
  });
}

const resetPasswordSchema = z.object({
  identifier: z.string().trim().min(1).max(254),
});

export async function requestPasswordReset(req: Request, res: Response) {
  const { identifier } = resetPasswordSchema.parse(req.body);
  const cleanId = identifier.trim().toLowerCase();

  // Matric numbers cannot self-reset (examination security policy)
  if (/^[a-z]{2,5}\/\d{2,4}\/\d+/i.test(cleanId)) {
    return res.status(403).json({
      error: {
        code: 'STUDENT_RESET_NOT_PERMITTED',
        message:
          'Student accounts cannot self-reset passwords online. In accordance with LASUSTECH examination security regulations, student password resets must be authorized by the ICT Administrator or CBT Center. Please visit the CBT Center or submit a request via the Support Desk.',
      },
    });
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { equals: cleanId, mode: 'insensitive' } },
        { matricNo: { equals: cleanId, mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      email: true,
      matricNo: true,
      roles: { select: { role: { select: { key: true } } } },
    },
  });

  if (user) {
    const roleKeys = user.roles.map((r) => r.role.key);
    const isStudentOnly = roleKeys.length > 0 && roleKeys.every((k) => k === 'STUDENT');
    if (isStudentOnly) {
      return res.status(403).json({
        error: {
          code: 'STUDENT_RESET_NOT_PERMITTED',
          message:
            'Student accounts cannot self-reset passwords online. In accordance with LASUSTECH examination security regulations, student password resets must be authorized by the ICT Administrator or CBT Center. Please visit the CBT Center or submit a request via the Support Desk.',
        },
      });
    }

    await auditOne(
      {
        actorId: user.id,
        actorRole: 'ANONYMOUS',
        ip: req.ip || 'unknown',
        userAgent: (req.get('user-agent') || 'unknown').slice(0, 300),
        requestId: String(res.locals.requestId),
      },
      {
        action: 'auth.password_reset_requested',
        targetType: 'User',
        targetId: user.id,
      },
    ).catch(() => {});
  }

  res.json({
    data: {
      success: true,
      message: 'If a staff or lecturer account exists for this identifier, instructions have been sent.',
    },
  });
}