import { Queue } from 'bullmq';
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

redisConnection.on('error', (err) => {
  console.warn(`[Redis] Connection warning: ${err.message}`);
});

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