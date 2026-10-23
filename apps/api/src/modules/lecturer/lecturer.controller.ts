import { Request, Response } from 'express';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { ownedQuestionWhere } from './questions.controller';

export const getLecturerCourses = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;

  const courses = await prisma.course.findMany({
    where: {
      active: true,
      assignments: { some: { userId } },
    },
    select: {
      id: true,
      code: true,
      title: true,
      units: true,
      level: true,
      defaultSemester: true,
    },
    orderBy: { code: 'asc' },
  });

  res.json({ data: courses });
};

export const getDashboardSummary = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;

  const [courses, subjects, questions, exams] = await Promise.all([
    prisma.courseAssignment.count({ where: { userId, course: { active: true } } }),
    prisma.subject.count({ where: { createdBy: userId, active: true } }),
    prisma.question.count({ where: ownedQuestionWhere(userId) }),
    prisma.exam.count({ where: { createdBy: userId } }),
  ]);

  res.json({
    data: {
      courses,
      subjects,
      questions,
      exams,
    },
  });
};

export const getLecturerTopics = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const courseId = typeof req.query.courseId === 'string' ? req.query.courseId : undefined;
  const subjectId = typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined;

  const topics = await prisma.topic.findMany({
    where: {
      ...(courseId
        ? { courseId, course: { assignments: { some: { userId } } } }
        : subjectId
          ? { subjectId, subject: { createdBy: userId } }
          : {
              OR: [
                { course: { assignments: { some: { userId } } } },
                { subject: { createdBy: userId } },
              ],
            }),
    },
    include: {
      course: { select: { id: true, code: true, title: true } },
      subject: { select: { id: true, name: true, level: true } },
    },
    orderBy: { name: 'asc' },
  });

  res.json({
    data: topics.map((topic) => ({
      ...topic,
      ownerLabel: topic.course
        ? `${topic.course.code} — ${topic.course.title}`
        : `${topic.subject?.name ?? 'Subject'}${topic.subject?.level ? ` (${topic.subject.level})` : ''}`,
    })),
  });
};

export const listExams = async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const audience = req.query.audience;
  const status = req.query.status;

  const exams = await prisma.exam.findMany({
    where: {
      OR: [
        { course: { active: true, assignments: { some: { userId } } } },
        { subject: { createdBy: userId } },
        { createdBy: userId, courseId: null, subjectId: null },
      ],
      ...(audience === 'PUBLIC' || audience === 'INSTITUTIONAL' ? { audience } : {}),
      ...(typeof status === 'string' && status !== 'ALL'
        ? { status: status as 'DRAFT' | 'IN_MODERATION' | 'APPROVED' | 'LOCKED' | 'ARCHIVED' }
        : {}),
    },
    include: {
      course: { select: { id: true, code: true, title: true, level: true } },
      subject: { select: { id: true, name: true, code: true, level: true, institution: true } },
      sections: { select: { _count: { select: { questions: true } } } },
      // A sitting may host attempts (a public exam's hidden sitting is where
      // every anonymous candidate lands), so candidates are counted through it.
      sittings: { select: { _count: { select: { attempts: true } } } },
      _count: { select: { sections: true, sittings: true } },
    },
    orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
  });

  res.json({
    data: exams.map((exam) => ({
      id: exam.id,
      title: exam.title,
      kind: exam.kind,
      kindLabel: exam.kindLabel,
      audience: exam.audience,
      status: exam.status,
      courseId: exam.courseId,
      subjectId: exam.subjectId,
      course: exam.course,
      subject: exam.subject,
      ownerLabel: exam.course
        ? `${exam.course.code} — ${exam.course.title}`
        : `${exam.subject?.name ?? 'Custom exam'}${exam.subject?.level ? ` (${exam.subject.level})` : ''}`,
      institutionName: exam.institutionName,
      levelLabel: exam.levelLabel,
      examBoard: exam.examBoard,
      durationMin: exam.durationMin,
      passMark: exam.passMark,
      publicSlug: exam.publicSlug,
      publicUrl:
        exam.audience === 'PUBLIC' && exam.publicSlug
          ? `${env.WEB_ORIGIN.replace(/\/$/, '')}/exam/${exam.publicSlug}`
          : null,
      publicOpensAt: exam.publicOpensAt,
      publicClosesAt: exam.publicClosesAt,
      publishedAt: exam.publishedAt,
      settings: exam.settings,
      sectionCount: exam._count.sections,
      questionCount: exam.sections.reduce((sum, section) => sum + section._count.questions, 0),
      sittingCount: exam._count.sittings,
      attemptCount: exam.sittings.reduce((sum, sitting) => sum + sitting._count.attempts, 0),
      createdAt: exam.createdAt,
    })),
  });
};
