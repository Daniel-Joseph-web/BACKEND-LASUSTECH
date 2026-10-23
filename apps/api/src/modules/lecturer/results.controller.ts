import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit } from '../../lib/audit';
import { uuidParam, sendCsv, toCsv } from '../../lib/http';
import { buildAttemptScriptPayload } from '../admin/results.controller';

async function verifyExamAccess(examId: string, userId: string) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      course: { include: { assignments: { where: { userId } } } },
      subject: { select: { name: true, code: true, createdBy: true } },
    },
  });

  if (!exam) throw Errors.notFound('Exam');
  const canAccess =
    exam.createdBy === userId ||
    (exam.course?.assignments.length ?? 0) > 0 ||
    exam.subject?.createdBy === userId;
  if (!canAccess) throw Errors.forbidden();
  return exam;
}

const formatDuration = (start?: Date | null, end?: Date | null) => {
  if (!start || !end) return 'N/A';
  const diffMs = Math.max(0, end.getTime() - start.getTime());
  const mins = Math.floor(diffMs / 60000);
  const secs = Math.floor((diffMs % 60000) / 1000);
  return `${mins}m ${secs}s`;
};

const resultInclude = {
  attempt: {
    select: {
      startedAt: true,
      submittedAt: true,
      student: { select: { names: true, matricNo: true } },
    },
  },
} as const;

// --- 1. Results dashboard ---
export const getExamResults = async (req: Request, res: Response) => {
  const examId = uuidParam(req);
  const actor = actorFrom(req, res);
  const exam = await verifyExamAccess(examId, actor.actorId);
  // The lecturer sets a pass mark per exam; fall back to the institution's
  // conventional 40% when they have not.
  const passMark = exam.passMark != null ? Number(exam.passMark) : 40;

  // One query; every figure below is derived from the same rows
  const rows = await prisma.result.findMany({
    where: { isCurrent: true, attempt: { sitting: { examId } } },
    include: resultInclude,
    orderBy: { percent: 'desc' },
  });

  const distribution = [
    { range: '0-39', count: 0, label: 'F' },
    { range: '40-44', count: 0, label: 'E' },
    { range: '45-49', count: 0, label: 'D' },
    { range: '50-59', count: 0, label: 'C' },
    { range: '60-69', count: 0, label: 'B' },
    { range: '70-100', count: 0, label: 'A' },
  ];

  let sum = 0;
  let passCount = 0;

  const students = rows.map((r) => {
    const percent = Number(r.percent);
    sum += percent;
    if (percent >= passMark) passCount++;

    if (percent >= 70) distribution[5].count++;
    else if (percent >= 60) distribution[4].count++;
    else if (percent >= 50) distribution[3].count++;
    else if (percent >= 45) distribution[2].count++;
    else if (percent >= 40) distribution[1].count++;
    else distribution[0].count++;

    const rawScore = Number(r.rawScore);
    const maxScore = Number(r.maxScore);

    return {
      id: r.id,
      attemptId: r.attemptId,
      matric: r.attempt.student.matricNo || 'Unknown',
      name: r.attempt.student.names,
      rawScore,
      maxScore,
      score: percent,
      percent,
      grade: r.grade,
      time: formatDuration(r.attempt.startedAt, r.attempt.submittedAt),
    };
  });

  const total = rows.length;

  res.json({
    data: {
      summary: {
        totalStudents: total,
        averageScore: (total ? sum / total : 0).toFixed(1),
        passRate: (total ? (passCount / total) * 100 : 0).toFixed(1),
      },
      distribution,
      students,
    },
  });
};

// --- 2. CSV export ---
export const exportExamResultsCsv = async (req: Request, res: Response) => {
  const examId = uuidParam(req);
  const actor = actorFrom(req, res);
  const exam = await verifyExamAccess(examId, actor.actorId);

  const rawResults = await prisma.result.findMany({
    where: { isCurrent: true, attempt: { sitting: { examId } } },
    include: resultInclude,
    orderBy: { attempt: { student: { matricNo: 'asc' } } },
  });

  const rows = rawResults.map((r) => [
    r.attempt.student.matricNo || 'Unknown',
    r.attempt.student.names,
    Number(r.rawScore).toString(),
    Number(r.maxScore).toString(),
    Number(r.percent).toFixed(1) + '%',
    r.grade,
    formatDuration(r.attempt.startedAt, r.attempt.submittedAt),
  ]);

  await prisma.$transaction((tx) =>
    writeAudit(tx, actor, {
      action: 'exam.export_results',
      targetType: 'Exam',
      targetId: examId,
      after: { count: rows.length },
    }),
  );

  const label = exam.course?.code ?? exam.subject?.code ?? exam.subject?.name ?? exam.title;
  const filename = `${label.replace(/\s+/g, '_')}_Results_${new Date().toISOString().slice(0, 10)}.csv`;
  sendCsv(
    res,
    filename,
    toCsv(['Matric Number', 'Candidate Name', 'Raw Score', 'Total Mark', 'Percentage', 'Grade', 'Time Taken'], rows),
  );
};

// --- 3. Script inspection (Read-Only) ---
export const getLecturerAttemptScript = async (req: Request, res: Response) => {
  const attemptId = uuidParam(req);
  const actor = actorFrom(req, res);

  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    select: {
      sitting: {
        select: { examId: true },
      },
    },
  });

  if (!attempt) throw Errors.notFound('Attempt');

  // Lecturers can only inspect scripts for exams they have permission to access.
  await verifyExamAccess(attempt.sitting.examId, actor.actorId);

  // Return the student's question-by-question breakdown. Lecturers CANNOT alter results.
  const script = await buildAttemptScriptPayload(attemptId);
  res.json({ data: script });
};
