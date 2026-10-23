import { Request, Response, NextFunction } from 'express';
import { redisConnection } from './queue';
import { Errors } from './errors';

interface RateLimiterOptions {
  windowSec: number;
  max: number;
  prefix: string;
  message?: string;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

interface MemoryBucket {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, MemoryBucket>();

// Clean up expired buckets periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of memoryStore.entries()) {
    if (bucket.resetAt <= now) {
      memoryStore.delete(key);
    }
  }
}, 30_000);

export function createRateLimiter(options: RateLimiterOptions) {
  const {
    windowSec,
    max,
    prefix,
    message = 'Too many requests. Please slow down and try again later.',
    keyGenerator = (req: Request) => req.ip || '127.0.0.1',
    skip,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    if (skip && skip(req)) {
      return next();
    }

    const key = `${prefix}:${keyGenerator(req)}`;

    try {
      if (redisConnection.status === 'ready') {
        const count = await redisConnection.incr(key);
        if (count === 1) {
          await redisConnection.expire(key, windowSec);
        }
        const ttl = await redisConnection.ttl(key);
        const retryAfter = ttl > 0 ? ttl : windowSec;

        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
        res.setHeader('X-RateLimit-Reset', retryAfter);

        if (count > max) {
          res.setHeader('Retry-After', retryAfter);
          return next(Errors.tooManyRequests(retryAfter, message));
        }

        return next();
      }
    } catch (err: any) {
      // If Redis fails, seamlessly fall back to memoryStore
      console.warn(`[RateLimiter] Redis error, falling back to memory: ${err.message}`);
    }

    // In-memory fallback
    const now = Date.now();
    let bucket = memoryStore.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = {
        count: 1,
        resetAt: now + windowSec * 1000,
      };
      memoryStore.set(key, bucket);
    } else {
      bucket.count += 1;
    }

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    res.setHeader('X-RateLimit-Reset', retryAfter);

    if (bucket.count > max) {
      res.setHeader('Retry-After', retryAfter);
      return next(Errors.tooManyRequests(retryAfter, message));
    }

    next();
  };
}

/**
 * 1. Global API Rate Limiter
 * 3,000 requests per 60 seconds per IP.
 * High enough to never block 600 legitimate candidates sharing a single CBT hall NAT IP.
 */
export const globalApiRateLimiter = createRateLimiter({
  prefix: 'rl:global',
  windowSec: 60,
  max: 3000,
  message: 'Campus network rate limit exceeded. Please wait a moment.',
  skip: (req) => req.path === '/health' || req.path === '/api/health/live' || req.path === '/api/health/ready',
});

/**
 * 2. Authentication Rate Limiter
 * 25 attempts per 15 minutes per IP + identifier.
 * Prevents credential brute forcing while allowing genuine forgotten password retries.
 */
export const authRateLimiter = createRateLimiter({
  prefix: 'rl:auth',
  windowSec: 15 * 60,
  max: 25,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.identifier || '').toLowerCase().trim()}`,
  message: 'Too many login attempts. Please wait 15 minutes before trying again.',
});

/**
 * 3. Candidate Exam Activity Limiter
 * Keyed by authenticated candidate ID / attempt ID (180 requests per 60 seconds).
 * Ensures that 600 candidates on the SAME network IP are independent and will never throttle each other.
 */
export const candidateExamRateLimiter = createRateLimiter({
  prefix: 'rl:student_exam',
  windowSec: 60,
  max: 180,
  keyGenerator: (req) => `${(req as any).auth?.userId || req.params.id || req.ip}`,
  message: 'Exam action submitted too rapidly. Please allow a few seconds between submissions.',
});

/**
 * 4. Sitting Access Code Brute-Force Guardian
 * Limits failed access code entries to 5 per 5 minutes per candidate & sitting.
 */
const accessCodeFailures = new Map<string, { count: number; lockUntil: number }>();

export async function checkAccessCodeRateLimit(userId: string, sittingId: string) {
  const key = `ac:${userId}:${sittingId}`;
  const now = Date.now();

  try {
    if (redisConnection.status === 'ready') {
      const lockKey = `${key}:locked`;
      const isLocked = await redisConnection.get(lockKey);
      if (isLocked) {
        const ttl = await redisConnection.ttl(lockKey);
        throw Errors.tooManyRequests(
          ttl > 0 ? ttl : 300,
          'Too many incorrect access code attempts. Access temporarily locked for 5 minutes. Please contact your invigilator.',
        );
      }
      return;
    }
  } catch (err: any) {
    if (err instanceof Errors.tooManyRequests) throw err;
  }

  // Memory fallback
  const record = accessCodeFailures.get(key);
  if (record && record.lockUntil > now) {
    const retrySec = Math.ceil((record.lockUntil - now) / 1000);
    throw Errors.tooManyRequests(
      retrySec,
      'Too many incorrect access code attempts. Access temporarily locked for 5 minutes. Please contact your invigilator.',
    );
  }
}

export async function recordFailedAccessCode(userId: string, sittingId: string) {
  const key = `ac:${userId}:${sittingId}`;
  const now = Date.now();
  const LOCK_DURATION_SEC = 300; // 5 minutes

  try {
    if (redisConnection.status === 'ready') {
      const count = await redisConnection.incr(key);
      if (count === 1) {
        await redisConnection.expire(key, LOCK_DURATION_SEC);
      }
      if (count >= 5) {
        await redisConnection.set(`${key}:locked`, '1', 'EX', LOCK_DURATION_SEC);
      }
      return;
    }
  } catch {
    // fallback
  }

  const record = accessCodeFailures.get(key) || { count: 0, lockUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.lockUntil = now + LOCK_DURATION_SEC * 1000;
  }
  accessCodeFailures.set(key, record);
}

export async function clearFailedAccessCode(userId: string, sittingId: string) {
  const key = `ac:${userId}:${sittingId}`;
  try {
    if (redisConnection.status === 'ready') {
      await redisConnection.del(key);
      await redisConnection.del(`${key}:locked`);
    }
  } catch {}
  accessCodeFailures.delete(key);
}
