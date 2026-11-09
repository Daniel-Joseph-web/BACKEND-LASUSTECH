import { Queue } from 'bullmq';
import Redis, { RedisOptions } from 'ioredis';

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
    console.warn(`[Redis] Connection warning: ${err.message}`);
  });

  return client;
}

export const redisConnection = createRedisClient();

export const QUESTION_IMPORT_QUEUE = 'question-import-queue';

export interface ImportJobPayload {
  importJobId: string;
  /** Institution import target. Exactly one of courseId / subjectId is set. */
  courseId?: string;
  /** School, entrance or external import target. */
  subjectId?: string;
  topicId: string;
  userId: string;
  fileBuffer: string; // Base64 encoded file payload
  originalName: string;
  mimetype: string;
}

export const questionImportQueue = new Queue<ImportJobPayload>(QUESTION_IMPORT_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

questionImportQueue.on('error', (err) => {
  console.warn(`[BullMQ] Queue warning: ${err.message}`);
});
