import { z } from 'zod';
import { blankToUndef } from '../../lib/http';

const optionSchema = z.object({
  position: z.number().int().min(0),
  body: z.record(z.string(), z.unknown()),
  isCorrect: z.boolean(),
  mediaId: z.preprocess(blankToUndef, z.string().uuid().nullish()),
});

const createQuestionBaseSchema = z.object({
  // Exactly one of courseId / subjectId. A course is an institution paper;
  // a subject is a school, entrance or external paper created by the lecturer.
  courseId: z.preprocess(blankToUndef, z.string().uuid().optional()),
  subjectId: z.preprocess(blankToUndef, z.string().uuid().optional()),
  // Optional: the controller falls back to the owner's "General" topic.
  topicId: z.preprocess(blankToUndef, z.string().uuid().optional()),
  answerFormat: z.enum(['MCQ_SINGLE', 'MCQ_MULTI', 'MATCHING']),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
  marks: z.coerce.number().min(0.5).max(100),
  stem: z.record(z.string(), z.unknown()),
  stemMediaId: z.preprocess(blankToUndef, z.string().uuid().nullish()),
  explanation: z.preprocess(blankToUndef, z.string().max(2000).optional()),
  hasMath: z.boolean().default(false),
  options: z.array(optionSchema).min(2).max(10),
  // No moderation: the author's save is the approval.
  status: z.enum(['DRAFT', 'PENDING', 'APPROVED']).default('APPROVED'),
});

const assertOwnerScope = (data: { courseId?: string; subjectId?: string }, ctx: z.RefinementCtx) => {
  if (!data.courseId && !data.subjectId) {
    ctx.addIssue({
      code: 'custom',
      message: 'Choose a course or a subject for this question.',
      path: ['courseId'],
    });
  }
  if (data.courseId && data.subjectId) {
    ctx.addIssue({
      code: 'custom',
      message: 'A question belongs to either a course or a subject, not both.',
      path: ['subjectId'],
    });
  }
};

export const createQuestionSchema = createQuestionBaseSchema
  .superRefine(assertOwnerScope)
  .superRefine((data, ctx) => {
    const correctCount = data.options.filter((o) => o.isCorrect).length;

    if (data.answerFormat === 'MCQ_SINGLE' && correctCount !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Single-choice questions must have exactly one correct answer.',
        path: ['options'],
      });
    }

    if (data.answerFormat === 'MCQ_MULTI' && correctCount < 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Multiple-choice questions must have at least one correct answer.',
        path: ['options'],
      });
    }
  });

export const updateQuestionSchema = createQuestionBaseSchema
  .partial()
  .extend({
    status: z.enum(['DRAFT', 'PENDING', 'APPROVED']).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.options && data.answerFormat) {
      const correctCount = data.options.filter((o) => o.isCorrect).length;

      if (data.answerFormat === 'MCQ_SINGLE' && correctCount !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'Single-choice questions must have exactly one correct answer.',
          path: ['options'],
        });
      }

      if (data.answerFormat === 'MCQ_MULTI' && correctCount < 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'Multiple-choice questions must have at least one correct answer.',
          path: ['options'],
        });
      }
    }
  });
