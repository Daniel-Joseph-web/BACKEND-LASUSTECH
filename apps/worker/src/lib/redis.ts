import Redis, { RedisOptions } from 'ioredis';
import 'dotenv/config';

export function createRedisClient(rawUrl?: string): Redis {
  let url = (rawUrl || process.env.REDIS_URL || 'redis://localhost:6379').trim();
  const isUpstash = url.includes('upstash.io');
  if (isUpstash && url.startsWith('redis://')) {
    url = url.replace(/^redis:\/\//, 'rediss://');
  }

  const options: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    connectTimeout: 10000,
    retryStrategy: (times: number) => Math.min(times * 100, 3000),
  };

  if (url.startsWith('rediss://') || isUpstash) {
    options.tls = { rejectUnauthorized: false };
  }

  const client = new Redis(url, options);
  client.on('error', (err) => {
    console.warn(`[Redis Worker] Connection warning: ${err.message}`);
  });

  return client;
}

export const redisConnection = createRedisClient();
