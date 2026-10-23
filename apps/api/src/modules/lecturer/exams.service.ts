import { Prisma } from '@lasustech-cbt/db';
import { Errors } from '../../lib/errors';
import type { Tx } from '../../lib/audit';

export type ExamScope = { courseId?: string | null; subjectId?: string | null };

export interface PaperRuleInput {
  mode: 'BY_RULE' | 'FIXED';
  difficulty?: 'EASY' | 'MEDIUM' | 'HARD';
  topicId?: string;
  count: number;
  marks: number;
  questionIds?: string[];
}

export interface PaperSectionInput {
  title: string;
  timerMode?: 'SHARED' | 'OWN';
  minutes?: number;
  weight?: number;
  rules: PaperRuleInput[];
}

/** Exams the caller may see: assigned course, owned subject, or created by them. */
export const ownedExamWhere = (userId: string): Prisma.ExamWhereInput => ({
  OR: [
    { course: { active: true, assignments: { some: { userId } } } },
    { subject: { createdBy: userId } },
    { createdBy: userId, courseId: null, subjectId: null },
  ],
});

export async function assertExamAccess(
  db: Tx,
  userId: string,
  scope: ExamScope,
  examId?: string,
) {
  if (scope.courseId) {
    if (
      !(await db.courseAssignment.findFirst({
        where: { courseId: scope.courseId, userId },
        // CourseAssignment has a composite key (course/user/session/role), so
        // there is no `id` to select.
        select: { courseId: true },
      }))
    ) {
      throw Errors.forbidden();
    }
    return;
  }
  if (scope.subjectId) {
    if (
      !(await db.subject.findFirst({
        where: { id: scope.subjectId, createdBy: userId },
        select: { id: true },
      }))
    ) {
      throw Errors.forbidden();
    }
    return;
  }
  if (examId) {
    const exam = await db.exam.findFirst({
      where: { id: examId, ...ownedExamWhere(userId) },
      select: { id: true },
    });
    if (!exam) throw Errors.forbidden();
    return;
  }
  throw Errors.badRequest('MISSING_SCOPE', 'Choose a course or a subject.');
}

const questionScopeWhere = (scope: ExamScope): Prisma.QuestionWhereInput =>
  scope.courseId ? { courseId: scope.courseId } : { subjectId: scope.subjectId };

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function approvedPool(tx: Tx, scope: ExamScope) {
  const questions = await tx.question.findMany({
    where: { ...questionScopeWhere(scope), currentVersionId: { not: null } },
    select: { currentVersionId: true },
  });
  const versionIds = questions
    .map((q) => q.currentVersionId)
    .filter((id): id is string => Boolean(id));
  if (!versionIds.length) return [];
  return tx.questionVersion.findMany({
    where: { id: { in: versionIds }, status: 'APPROVED' },
    select: { id: true, marks: true, topicId: true, difficulty: true },
  });
}

/**
 * Creates ExamSection/ExamRule/ExamQuestion rows for a published paper.
 * The pool belongs to a course (institution) or a subject (school/external).
 */
export async function materializePaper(
  tx: Tx,
  examId: string,
  scope: ExamScope,
  sections: PaperSectionInput[],
) {
  const pool = await approvedPool(tx, scope);
  const poolById = new Map(pool.map((v) => [v.id, v]));
  const used = new Set<string>();
  let totalMarks = 0;
  let questionCount = 0;

  for (let index = 0; index < sections.length; index += 1) {
    const input = sections[index];
    const section = await tx.examSection.create({
      data: {
        examId,
        position: index + 1,
        title: input.title,
        timerMode: input.timerMode ?? 'SHARED',
        minutes: input.minutes,
        weight: input.weight ?? 1,
      },
    });

    let position = 0;

    for (const rule of input.rules) {
      let chosen: string[] = [];

      if (rule.mode === 'FIXED') {
        const requested = (rule.questionIds ?? []).map((id) => id.trim()).filter(Boolean);
        if (requested.length < rule.count) {
          throw Errors.conflict(
            'INSUFFICIENT_QUESTIONS',
            `"${input.title}" needs ${rule.count} hand-picked question(s), but only ${requested.length} were selected.`,
          );
        }
        const rows = await tx.question.findMany({
          where: {
            id: { in: requested },
            ...questionScopeWhere(scope),
            currentVersionId: { not: null },
          },
          select: { currentVersionId: true },
        });
        chosen = rows
          .map((r) => r.currentVersionId)
          .filter((id): id is string => id !== null && poolById.has(id))
          .filter((id) => !used.has(id))
          .slice(0, rule.count);
      } else {
        const candidates = pool.filter(
          (v) =>
            !used.has(v.id) &&
            (!rule.topicId || v.topicId === rule.topicId) &&
            (!rule.difficulty || v.difficulty === rule.difficulty),
        );
        chosen = shuffle(candidates)
          .slice(0, rule.count)
          .map((v) => v.id);
      }

      if (chosen.length < rule.count) {
        throw Errors.conflict(
          'INSUFFICIENT_QUESTIONS',
          `Rule in "${input.title}" requests ${rule.count} question(s), but only ${chosen.length} approved question(s) are available. Add more questions or lower the count.`,
          { section: input.title, requested: rule.count, available: chosen.length },
        );
      }

      await tx.examRule.create({
        data: {
          sectionId: section.id,
          mode: rule.mode,
          difficulty: rule.difficulty,
          topicId: rule.topicId,
          count: rule.count,
          marks: new Prisma.Decimal(rule.marks),
        },
      });

      await tx.examQuestion.createMany({
        data: chosen.map((versionId) => ({
          sectionId: section.id,
          questionVersionId: versionId,
          position: position++,
        })),
      });

      for (const versionId of chosen) {
        used.add(versionId);
        totalMarks += Number(poolById.get(versionId)?.marks ?? rule.marks);
        questionCount += 1;
      }
    }
  }

  return { questionCount, totalMarks };
}
