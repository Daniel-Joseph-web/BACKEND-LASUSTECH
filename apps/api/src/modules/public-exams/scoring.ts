import { Prisma } from '@lasustech-cbt/db';
import { Errors } from '../../lib/errors';
import { getGroup } from '../../lib/settings';

export type GradeKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface GradeBandInput {
  grade: GradeKey;
  minPercent: number;
  maxPercent: number;
  label?: string;
}

export interface ScoreSummary {
  rawScore: number;
  maxScore: number;
  percent: number;
  grade: GradeKey;
  gradeLabel: string | null;
  passed: boolean;
}

const DEFAULT_BANDS: GradeBandInput[] = [
  { grade: 'A', minPercent: 70, maxPercent: 100 },
  { grade: 'B', minPercent: 60, maxPercent: 69.99 },
  { grade: 'C', minPercent: 50, maxPercent: 59.99 },
  { grade: 'D', minPercent: 45, maxPercent: 49.99 },
  { grade: 'E', minPercent: 40, maxPercent: 44.99 },
  { grade: 'F', minPercent: 0, maxPercent: 39.99 },
];

function parseCustomBands(settings: Prisma.JsonValue | null | undefined): GradeBandInput[] {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return [];
  const bands = (settings as { gradeBands?: unknown }).gradeBands;
  if (!Array.isArray(bands)) return [];

  const parsed: GradeBandInput[] = [];
  for (const band of bands) {
    if (!band || typeof band !== 'object') continue;
    const b = band as Record<string, unknown>;
    const grade = typeof b.grade === 'string' ? b.grade.toUpperCase() : '';
    const minPercent = Number(b.minPercent);
    const maxPercent = Number(b.maxPercent);
    if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(grade)) continue;
    if (!Number.isFinite(minPercent) || !Number.isFinite(maxPercent)) continue;
    parsed.push({
      grade: grade as GradeKey,
      minPercent,
      maxPercent,
      label: typeof b.label === 'string' ? b.label : undefined,
    });
  }
  return parsed.sort((a, b) => b.minPercent - a.minPercent);
}

function resolveGrade(percent: number, bands: GradeBandInput[]) {
  const band = bands.find((b) => percent >= b.minPercent && percent <= b.maxPercent);
  if (band) return { grade: band.grade, label: band.label ?? null };
  // Percentage outside every configured range (misconfigured bands): fall back
  // to the nearest lower band rather than refusing to score the attempt.
  const lower = bands.filter((b) => percent >= b.minPercent).sort((a, b) => b.minPercent - a.minPercent)[0];
  if (lower) return { grade: lower.grade, label: lower.label ?? null };
  return { grade: 'F' as GradeKey, label: null };
}

async function loadBands(tx: Prisma.TransactionClient, settings: Prisma.JsonValue | null | undefined) {
  const custom = parseCustomBands(settings);
  if (custom.length) return custom;

  const stored = await tx.gradeBand.findMany({
    orderBy: { minPercent: 'desc' },
    select: { grade: true, minPercent: true, maxPercent: true, label: true },
  });
  if (stored.length) {
    return stored.map((band) => ({
      grade: band.grade as GradeKey,
      minPercent: Number(band.minPercent),
      maxPercent: Number(band.maxPercent),
      label: band.label ?? undefined,
    }));
  }
  return DEFAULT_BANDS;
}

/**
 * Scores an attempt synchronously and writes the current Result row.
 * Public exams are self-contained, so there is no moderation step: the result
 * is RELEASED immediately and `showResults` only controls what the candidate
 * is shown in the response.
 */
export async function scoreAttempt(
  tx: Prisma.TransactionClient,
  attemptId: string,
  options: { auto: boolean; endedReason: 'STUDENT_SUBMIT' | 'AUTO_SUBMIT' | 'EXPIRED' },
): Promise<ScoreSummary> {
  const attempt = await tx.attempt.findUnique({
    where: { id: attemptId },
    include: {
      questions: {
        include: {
          questionVersion: {
            include: { options: { orderBy: { position: 'asc' } } },
          },
        },
      },
      answers: true,
      sitting: { include: { exam: true } },
    },
  });

  if (!attempt) throw Errors.notFound('Attempt');
  if (attempt.status !== 'IN_PROGRESS' && attempt.status !== 'PAUSED') {
    throw Errors.conflict('ATTEMPT_CLOSED', 'This attempt has already been submitted.');
  }

  const answersByQuestion = new Map(attempt.answers.map((answer) => [answer.questionVersionId, answer]));
  let rawScore = 0;
  let maxScore = 0;
  const sectionTotals = new Map<string, { score: number; max: number }>();

  for (const question of attempt.questions) {
    const marks = Number(question.weightedMarks);
    maxScore += marks;
    const totals = sectionTotals.get(question.sectionId) ?? { score: 0, max: 0 };
    totals.max += marks;

    const answer = answersByQuestion.get(question.questionVersionId);
    const selected = new Set(readSelectedPositions(answer?.value));
    const correct = new Set(
      question.questionVersion.options.filter((option) => option.isCorrect).map((option) => option.position),
    );

    const isCorrect =
      correct.size > 0 &&
      selected.size === correct.size &&
      [...selected].every((position) => correct.has(position));

    const examSettings = await getGroup('exam');

    if (isCorrect) {
      rawScore += marks;
      totals.score += marks;
    } else if (examSettings.negativeMarking && selected.size > 0) {
      // Deduct 25% penalty for incorrect responses when negative marking is enabled
      const penalty = marks * 0.25;
      rawScore -= penalty;
      totals.score -= penalty;
    }
    sectionTotals.set(question.sectionId, totals);
  }

  rawScore = Math.max(0, rawScore);
  for (const [sId, totals] of sectionTotals.entries()) {
    totals.score = Math.max(0, totals.score);
  }

  const percent = maxScore > 0 ? Math.round((rawScore / maxScore) * 10000) / 100 : 0;
  const bands = await loadBands(tx, attempt.sitting.exam.settings);
  const { grade, label } = resolveGrade(percent, bands);
  const passMark = attempt.sitting.exam.passMark != null ? Number(attempt.sitting.exam.passMark) : 50;
  const passed = percent >= passMark;

  const previous = await tx.result.findMany({
    where: { attemptId },
    select: { scoreVersion: true, isCurrent: true },
  });
  if (previous.some((result) => result.isCurrent)) {
    await tx.result.updateMany({ where: { attemptId, isCurrent: true }, data: { isCurrent: false } });
  }
  const scoreVersion = previous.reduce((max, result) => Math.max(max, result.scoreVersion), 0) + 1;

  const isPublicExam = Boolean(attempt.sitting.isPublic || attempt.sitting.exam.audience === 'PUBLIC');
  const initialStatus = isPublicExam ? 'RELEASED' : 'SCORED';

  const result = await tx.result.create({
    data: {
      attemptId,
      scoreVersion,
      rawScore: new Prisma.Decimal(rawScore),
      maxScore: new Prisma.Decimal(maxScore),
      percent: new Prisma.Decimal(percent),
      grade,
      status: initialStatus,
      isCurrent: true,
    },
  });

  if (sectionTotals.size) {
    await tx.sectionScore.createMany({
      data: [...sectionTotals.entries()].map(([sectionId, totals]) => ({
        resultId: result.id,
        sectionId,
        score: new Prisma.Decimal(Math.round(totals.score * 100) / 100),
        maxScore: new Prisma.Decimal(Math.round(totals.max * 100) / 100),
      })),
    });
  }

  await tx.attempt.update({
    where: { id: attemptId },
    data: {
      status: options.auto ? 'AUTO_SUBMITTED' : 'SUBMITTED',
      submittedAt: new Date(),
      endedReason: options.endedReason,
    },
  });

  return {
    rawScore: Math.round(rawScore * 100) / 100,
    maxScore: Math.round(maxScore * 100) / 100,
    percent,
    grade,
    gradeLabel: label,
    passed,
  };
}

export function readSelectedPositions(value: Prisma.JsonValue | undefined): number[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const selected = (value as { selected?: unknown }).selected;
  if (!Array.isArray(selected)) return [];
  return selected.filter((position): position is number => Number.isInteger(position));
}
