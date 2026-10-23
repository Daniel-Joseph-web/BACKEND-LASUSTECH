import http from 'http';
import net from 'net';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ZodError } from 'zod';
import { env } from './config/env';
import { AppError } from './lib/errors';
import { prisma } from './lib/prisma';
import { redisConnection } from './lib/queue';
import { syncSittingStatuses } from './modules/student/student.service';
import { assertLeastPrivilege } from './lib/db-guard';
import { login, refresh, logout, me, verifyClearanceCode, requestPasswordReset } from './modules/auth/auth.controller';
import { requireAuth } from './modules/auth/auth.middleware';
import { adminRouter } from './modules/admin/admin.routes';
import { lecturerRouter } from './modules/lecturer/lecturer.routes';
import { getMediaFile } from './modules/lecturer/media.controller';
import { publicExamRouter } from './modules/public-exams/public-exams.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { studentRouter } from './modules/student/student.routes';
import { listSessionsPublic } from './modules/admin/sessions.controller';
import { createPublicSupportTicket } from './modules/admin/support.controller';
import { getGroup } from './lib/settings';
import { authRateLimiter, globalApiRateLimiter } from './lib/rate-limiter';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);

// 1. Mandatory Security Headers & Request Correlation
app.use((_req, res, next) => {
  const id = crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

// 2. Global Layer-7 Anti-Flood Rate Limiter
app.use(globalApiRateLimiter);

const allowedOrigins = (env.WEB_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const isAllowed =
        origin.endsWith('.vercel.app') ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        allowedOrigins.includes(origin);

      if (isAllowed) return callback(null, true);
      if (env.NODE_ENV === 'production' && allowedOrigins.length > 0) {
        return callback(new Error('CORS: Origin blocked by university security policy'), false);
      }
      return callback(null, true);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

const v1 = express.Router();
v1.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
v1.get('/system/status', async (_req, res) => {
  const general = await getGroup('general');
  res.json({
    data: {
      maintenanceMode: general.maintenanceMode,
      liveExamMode: general.liveExamMode,
      platformName: general.platformName,
    },
  });
});
v1.post('/auth/login', authRateLimiter, login);
v1.post('/auth/refresh', refresh);
v1.post('/auth/logout', logout);
v1.post('/auth/verify', authRateLimiter, verifyClearanceCode);
v1.post('/auth/reset-password', authRateLimiter, requestPasswordReset);
v1.post('/support', createPublicSupportTicket);
v1.get('/me', requireAuth, me);
v1.get('/sessions', requireAuth, listSessionsPublic);
// Question figures are public so anonymous public-exam candidates can see them.
// Content is content-addressed and immutable, so this is safe to cache forever.
v1.get('/media/:id', getMediaFile);
v1.use('/public', publicExamRouter);
v1.use('/notifications', notificationsRouter);
v1.use('/admin', adminRouter);
v1.use('/lecturer', lecturerRouter);
v1.use('/student', studentRouter);

// Proxy Socket.io HTTP polling to Realtime service on port 3002
app.use('/socket.io', (req, res) => {
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: 3002,
      path: req.originalUrl || req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: 'localhost:3002',
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    console.warn('[Socket.io Proxy] Realtime service unreachable on port 3002:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Realtime service unavailable' });
    }
  });

  req.pipe(proxyReq);
});

app.use('/api/v1', v1);

/**
 * Diagnostic, not a feature: `prisma generate` rewrites the client on disk but
 * a running process keeps the copy it loaded at boot. When the two disagree
 * every schema-dependent endpoint 500s with an unrelated-looking Prisma error,
 * which is very hard to read from the outside. Reporting boot time next to the
 * generated client's timestamp lets the smoke test name the real problem.
 */
const BOOTED_AT = new Date();

/** ioredis status: 'ready' | 'connecting' | 'reconnecting' | 'close' | 'end'. */
function queueRedisStatus(): string {
  return redisConnection.status;
}

function prismaClientBuiltAt(): string | null {
  const candidates: string[] = [];

  // The API imports Prisma through @lasustech-cbt/db, so the client is not
  // necessarily resolvable from this package. Try the normal resolver first,
  // then the two layouts this repo actually uses (pnpm workspace, cwd = apps/api).
  try {
    candidates.push(path.dirname(require.resolve('@prisma/client')));
  } catch {
    // expected: @prisma/client is a dependency of packages/db, not of the API
  }
  candidates.push(
    path.resolve(process.cwd(), 'node_modules/@prisma/client'),
    path.resolve(process.cwd(), '../../packages/db/node_modules/@prisma/client'),
    path.resolve(__dirname, '../../../packages/db/node_modules/@prisma/client'),
  );

  for (const dir of candidates) {
    try {
      // realpath follows the pnpm symlink into the store, which is where the
      // generated .prisma/client directory actually lives. From
      // .../node_modules/@prisma/client it is two levels up (out of the
      // @prisma scope directory) and then into .prisma/client.
      const real = fs.realpathSync(dir);
      const generated = path.resolve(real, '../../.prisma/client/index.js');
      return fs.statSync(generated).mtime.toISOString();
    } catch {
      // try the next candidate
    }
  }
  return null;
}

app.get('/api/health/live', (_req, res) =>
  res.json({
    status: 'ok',
    bootedAt: BOOTED_AT.toISOString(),
    prismaClientBuiltAt: prismaClientBuiltAt(),
  }),
);
app.get('/api/health/ready', async (_req, res) => {
  // Redis is reported but does not fail readiness: everything except document
  // import works without it, and a 503 here would take the whole site down over
  // a degraded background queue. The field makes the degradation visible.
  const redis = queueRedisStatus();

  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'ok', redis });
  } catch {
    res.status(503).json({ status: 'unavailable', database: 'down', redis });
  }
});

app.use((_req, res) =>
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: res.locals.requestId },
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const requestId = res.locals.requestId;
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
  }
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Check the form and try again.',
        details: err.issues,
        requestId,
      },
    });
  }
  const e = err as { code?: string; type?: string };
  if (e?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'BAD_JSON', message: 'Malformed request body.', requestId } });
  }
  if (e?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'TOO_LARGE', message: 'Request body is too large.', requestId } });
  }
  if (e?.code === 'P2002') {
    return res
      .status(409)
      .json({ error: { code: 'ALREADY_EXISTS', message: 'That record already exists.', requestId } });
  }
  if (e?.code === 'P2003') {
    return res.status(409).json({
      error: { code: 'IN_USE', message: 'This record is still referenced by other data.', requestId },
    });
  }
  if (e?.code === 'P2025') {
    return res
      .status(404)
      .json({ error: { code: 'NOT_FOUND', message: 'Record not found.', requestId } });
  }
  console.error(requestId, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error', requestId } });
});

async function start() {
  // Fail closed if the connection can do more than the API needs. See
  // lib/db-guard.ts and migration 2_identity_hardening.
  await assertLeastPrivilege();

  // Periodically synchronize sitting statuses (auto-open scheduled and auto-close expired)
  void syncSittingStatuses().catch(() => {});
  const syncInterval = setInterval(() => {
    void syncSittingStatuses().catch(() => {});
  }, 15_000);

  const server = app.listen(env.PORT, () => {
    console.log(`API running on port ${env.PORT}`);
    console.log(`Proxying /socket.io and WebSocket upgrades -> 127.0.0.1:3002`);
  });

  server.on('upgrade', (req, clientSocket, head) => {
    if (req.url && req.url.startsWith('/socket.io')) {
      const proxySocket = net.connect(3002, '127.0.0.1', () => {
        let rawReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i];
          const val = name.toLowerCase() === 'host' ? 'localhost:3002' : req.rawHeaders[i + 1];
          rawReq += `${name}: ${val}\r\n`;
        }
        rawReq += '\r\n';

        proxySocket.write(rawReq);
        if (head && head.length > 0) {
          proxySocket.write(head);
        }

        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);
      });

      proxySocket.on('error', (err) => {
        console.warn('[WebSocket Upgrade Proxy] Error:', err.message);
        clientSocket.destroy();
      });

      clientSocket.on('error', () => {
        proxySocket.destroy();
      });
    } else {
      clientSocket.destroy();
    }
  });

  const shutdown = () => {
    clearInterval(syncInterval);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(async (e) => {
  console.error(e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});