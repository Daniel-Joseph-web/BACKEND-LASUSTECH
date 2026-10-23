import dotenv from 'dotenv';
import path from 'node:path';

// The worker's own env file. `../../.env` resolved to apps/.env, which does
// not exist, so the explicit load was silently a no-op (dotenv/config on the
// import graph was doing the real work). `../.env` is correct from both
// apps/worker/src (ts-node) and apps/worker/dist (compiled).
dotenv.config({
  path: path.resolve(__dirname, '../.env'),
});

import { Worker } from 'bullmq';
import { redisConnection } from './lib/redis';
import { processQuestionImportJob } from './modules/import/import.processor';

const QUEUE_NAME = 'question-import-queue';

console.log('🚀 LASUSTECH CBT Background Worker starting up...');
console.log(`📋 Queue name: ${QUEUE_NAME}`);
console.log('🔌 Connecting to Redis...');

const importWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    console.log(
      `📥 [Job ${job.id}] Received import job.`,
      {
        importJobId: job.data.importJobId,
        originalName: job.data.originalName,
      },
    );

    try {
      const result = await processQuestionImportJob(job);

      console.log(
        `✅ [Job ${job.id}] Processing completed.`,
        result,
      );

      return result;
    } catch (error) {
      console.error(
        `❌ [Job ${job.id}] Import processing failed:`,
        error,
      );

      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  },
);

importWorker.on('ready', () => {
  console.log('✅ Worker is ready and connected to Redis.');
  console.log(`👂 Listening for jobs on "${QUEUE_NAME}"...`);
});

importWorker.on('active', (job) => {
  console.log(`⚙️ [Job ${job.id}] Job is now active.`);
});

importWorker.on('completed', (job) => {
  console.log(`🎉 [Job ${job.id}] Successfully completed.`);
});

importWorker.on('failed', (job, error) => {
  console.error(
    `❌ [Job ${job?.id ?? 'unknown'}] Failed:`,
    error,
  );
});

importWorker.on('error', (error) => {
  console.error('❌ BullMQ worker error:', error);
});

importWorker.on('stalled', (jobId) => {
  console.warn(`⚠️ [Job ${jobId}] Job stalled.`);
});

importWorker
  .waitUntilReady()
  .then(() => {
    console.log('🟢 Worker startup check passed.');
  })
  .catch((error: unknown) => {
    console.error('🔴 Worker could not become ready:', error);
  });