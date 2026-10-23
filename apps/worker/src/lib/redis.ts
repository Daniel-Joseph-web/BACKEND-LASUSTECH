import Redis from 'ioredis';
import 'dotenv/config';

export const redisConnection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

redisConnection.on('error', (err) => {
  console.warn(`[Redis] Connection warning: ${err.message}`);
});