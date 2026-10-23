import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom } from '../../lib/audit';
import { questionImportQueue } from '../../lib/queue';
import { uuidParam } from '../../lib/http';

/**
 * Long enough for a slow-but-alive Redis, short enough that a request against a
 * dead one fails while the user is still looking at the upload screen.
 */
const QUEUE_ENQUEUE_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The job queue did not respond within ${ms / 1000}s.`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}


export const downloadTemplate = (_req: Request, res: Response) => {
  const AIKEN_TEMPLATE = `What is the time complexity of searching in a balanced binary search tree?
A. O(1)
B. O(n)
C. O(log n)
D. O(n log n)
ANSWER: C

Which data structure operates on a Last In First Out (LIFO) principle?
A. Queue
B. Stack
C. Linked List
D. Tree
ANSWER: B`;

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename="aiken_template.txt"');
  res.send(AIKEN_TEMPLATE);
};

export const submitQuestionImportJob = async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    throw Errors.badRequest(
      'NO_FILE',
      'An upload document is required (.xlsx/.xls, .csv, .docx/.doc, .pdf, .txt, or a JPG/PNG photo).',
    );
  }

  const bodyCourseId = typeof req.body.courseId === 'string' ? req.body.courseId.trim() : '';
  const bodySubjectId = typeof req.body.subjectId === 'string' ? req.body.subjectId.trim() : '';
  const courseId = bodyCourseId || undefined;
  const subjectId = bodySubjectId || undefined;
  let topicId: string | undefined =
    typeof req.body.topicId === 'string' && req.body.topicId.trim() ? req.body.topicId.trim() : undefined;

  if (courseId && subjectId) {
    throw Errors.badRequest('AMBIGUOUS_SCOPE', 'Import into either a course or a subject, not both.');
  }
  if (!courseId && !subjectId) {
    throw Errors.badRequest('MISSING_FIELDS', 'Choose a course or a subject for this import.');
  }

  const actor = actorFrom(req, res);

  if (courseId) {
    // Check lecturer assignment for the selected course.
    const assignment = await prisma.courseAssignment.findFirst({
      where: { courseId, userId: actor.actorId },
    });

    if (!assignment) {
      throw Errors.forbidden();
    }
  } else if (subjectId) {
    // Subjects are owned by the lecturer who created them (schools, external).
    const subject = await prisma.subject.findFirst({
      where: { id: subjectId, createdBy: actor.actorId, active: true },
      select: { id: true },
    });
    if (!subject) {
      throw Errors.forbidden();
    }
  }

  // If no topic was selected, resolve to a real topic. Uses upsert so that
  // repeated imports against the same course/subject reuse a single "Imported
  // Questions" topic instead of creating duplicates.
  if (!topicId) {
    const topic = courseId
      ? await prisma.topic.upsert({
          where: { courseId_name: { courseId, name: 'Imported Questions' } },
          update: {},
          create: { courseId, name: 'Imported Questions' },
        })
      : await prisma.topic.upsert({
          where: { subjectId_name: { subjectId: subjectId!, name: 'Imported Questions' } },
          update: {},
          create: { subjectId: subjectId!, name: 'Imported Questions' },
        });

    topicId = topic.id;
  } else {
    // Ensure the supplied topic actually belongs to the selected course/subject.
    const topic = await prisma.topic.findFirst({
      where: courseId ? { id: topicId, courseId } : { id: topicId, subjectId },
      select: { id: true },
    });

    if (!topic) {
      throw Errors.badRequest(
        'INVALID_TOPIC',
        'The selected topic does not belong to this course or subject.',
      );
    }
  }

  // At this point topicId is guaranteed to be a real string, but narrow
  // explicitly so the subsequent object literal sees a `string`, not
  // `string | undefined`.
  if (!topicId) {
    throw Errors.badRequest('INVALID_TOPIC', 'Topic could not be resolved.');
  }

  // 1. Create tracking record in ImportJob table
  const importJob = await prisma.importJob.create({
    data: {
      type: 'QUESTION_BULK_IMPORT',
      status: 'QUEUED',
      inputObjectKey: file.originalname,
      createdBy: actor.actorId,
    },
  });

  // 2. Dispatch to BullMQ worker with the resolved topicId
  //
  // BullMQ is configured with maxRetriesPerRequest: null (required by workers),
  // so when Redis is down `add()` waits for a connection forever and the HTTP
  // request hangs. Bound it, and leave a truthful FAILED row behind instead of a
  // QUEUED one that nothing will ever pick up.
  const addPromise = questionImportQueue.add('process-document', {
    importJobId: importJob.id,
    ...(courseId ? { courseId } : { subjectId: subjectId! }),
    topicId,
    userId: actor.actorId,
    fileBuffer: file.buffer.toString('base64'),
    originalName: file.originalname,
    mimetype: file.mimetype,
  });

  let queueJobId: string | undefined;
  try {
    const bullJob = await withTimeout(addPromise, QUEUE_ENQUEUE_TIMEOUT_MS);
    queueJobId = bullJob.id;
  } catch (error) {
    // If Redis recovers after we gave up, ioredis may still flush the buffered
    // command. Remove that job so work the caller was told had failed cannot
    // silently run behind their back.
    addPromise.then((job) => job.remove()).catch(() => {});

    await prisma.importJob
      .update({
        where: { id: importJob.id },
        data: {
          status: 'FAILED',
          errors: {
            message:
              error instanceof Error ? error.message : 'The import queue did not accept the job.',
          },
        },
      })
      .catch(() => {});

    throw Errors.serviceUnavailable(
      'IMPORT_QUEUE_UNAVAILABLE',
      'Document import is unavailable because the job queue (Redis) is not reachable. Start Redis and try again.',
    );
  }

  res.status(202).json({
    data: {
      jobId: importJob.id,
      queueId: queueJobId,
      status: 'QUEUED',
      message:
        'File accepted. Parsing and extraction running in background worker.',
    },
  });
};

export const getImportJobStatus = async (req: Request, res: Response) => {
  const id = uuidParam(req, 'jobId');
  const userId = req.auth!.userId;

  // Import-job IDs are not secrets: restrict status reads to the owner.
  const job = await prisma.importJob.findFirst({
    where: { id, createdBy: userId },
  });

  if (!job) {
    throw Errors.notFound('Import job');
  }

  // The worker stores a JSON summary (counts, provider, images) in the result
  // key; older jobs stored a plain sentence, so fall back gracefully.
  let counts: Record<string, unknown> | null = null;
  if (job.resultObjectKey) {
    try {
      const parsed: unknown = JSON.parse(job.resultObjectKey);
      if (parsed && typeof parsed === 'object') counts = parsed as Record<string, unknown>;
    } catch {
      counts = null;
    }
  }

  res.json({
    data: {
      id: job.id,
      status: job.status,
      fileName: job.inputObjectKey,
      resultKey: job.resultObjectKey,
      counts,
      errors: job.errors,
    },
  });
};
