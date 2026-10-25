import bcrypt from 'bcryptjs';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { mediaUrl, mediaView } from '../../lib/media';
import { getGroup } from '../../lib/settings';
import { readSelectedPositions, scoreAttempt, ScoreSummary } from '../public-exams/scoring';
import { buildAttemptScriptPayload } from '../admin/results.controller';

import { publishRealtimeEvent } from '../../lib/realtime';
import { notifyUsers } from '../../lib/notify';
import {
  checkAccessCodeRateLimit,
  clearFailedAccessCode,
  recordFailedAccessCode,
} from '../../lib/rate-limiter';

interface SittingPaperCacheItem {
  candidateQuestions: Array<{
    sectionId: string;
    questionVersionId: string;
    weightedMarks: number;
    options: { position: number }[];
  }>;
  totalMarks: number;
  cachedAt: number;
}
const sittingPaperCache = new Map<string, SittingPaperCacheItem>();
const lastHeartbeatEventDbWrite = new Map<string, number>();

/**
 * Automatically synchronizes sitting statuses:
 * 1. Transitions SCHEDULED sittings to OPEN when startsAt has arrived and now <= endsAt.
 * 2. Transitions OPEN sittings to CLOSED when endsAt has passed and auto-submits lingering attempts.
 * 3. Broadcasts realtime events and dispatches notifications so users see status switch instantly.
 */
export async function syncSittingStatuses() {
  const now = new Date();
  try {
    // 1. Auto-open SCHEDULED sittings whose time has arrived
    const toOpen = await prisma.sitting.findMany({
      where: {
        status: 'SCHEDULED',
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      include: {
        exam: {
          select: {
            title: true,
            course: { select: { code: true } },
            subject: { select: { name: true } },
          },
        },
        students: { select: { studentId: true } },
      },
    });

    for (const sitting of toOpen) {
      await prisma.sitting.update({
        where: { id: sitting.id },
        data: { status: 'OPEN' },
      });

      const label = sitting.exam.course
        ? sitting.exam.course.code
        : (sitting.exam.subject?.name ?? sitting.exam.title);

      if (sitting.students.length > 0) {
        await prisma.$transaction(async (tx) => {
          await notifyUsers(
            tx,
            sitting.students.map((s) => s.studentId),
            {
              type: 'EXAM_REMINDER',
              title: `Exam is Now Live: ${label}`,
              body: `${label} — "${sitting.exam.title}" has started. Proceed to your exam screen.`,
              meta: { kind: 'EXAM_LIVE', sittingId: sitting.id, href: '/student' },
            },
          );
        }).catch(() => {});
      }

      void publishRealtimeEvent({
        event: 'sitting.status',
        target: { roles: ['ADMIN', 'LECTURER', 'STUDENT'] },
        data: {
          sittingId: sitting.id,
          status: 'OPEN',
          examTitle: sitting.exam.title,
          label,
        },
      });
    }

    // 2. Auto-close expired sittings
    const expired = await prisma.sitting.findMany({
      where: {
        status: 'OPEN',
        endsAt: { lt: now },
      },
      select: { id: true },
    });

    if (expired.length > 0) {
      const expiredIds = expired.map((s) => s.id);
      await prisma.sitting.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: 'CLOSED' },
      });

      const lingering = await prisma.attempt.findMany({
        where: {
          sittingId: { in: expiredIds },
          status: 'IN_PROGRESS',
        },
        select: { id: true },
      });

      for (const att of lingering) {
        await prisma.$transaction(async (tx) => {
          await scoreAttempt(tx, att.id, {
            auto: true,
            endedReason: 'AUTO_SUBMIT',
          }).catch(() => {});
        }).catch(() => {});
      }

      for (const id of expiredIds) {
        void publishRealtimeEvent({
          event: 'sitting.status',
          target: { roles: ['ADMIN', 'LECTURER', 'STUDENT'] },
          data: { sittingId: id, status: 'CLOSED' },
        });
      }
    }
  } catch (err: any) {
    console.warn('[Sync Sittings] Warning:', err?.message);
  }
}

// Alias for existing callers
export const closeExpiredSittings = syncSittingStatuses;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function gradeToPoint(grade: string): number {
  switch (grade.toUpperCase()) {
    case 'A': return 5.0;
    case 'B': return 4.0;
    case 'C': return 3.0;
    case 'D': return 2.0;
    case 'E': return 1.0;
    default: return 0.0;
  }
}

export async function getStudentProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      names: true,
      email: true,
      matricNo: true,
      departmentId: true,
      department: {
        include: {
          college: true,
        },
      },
      profile: {
        include: {
          programme: {
            include: {
              department: {
                include: {
                  college: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!user) throw Errors.notFound('Student');

  const namesParts = user.names.trim().split(/\s+/);
  const firstName = namesParts[0] || 'Student';
  const profile = user.profile;
  const programme = profile?.programme;
  const department = programme?.department || user.department;
  const college = department?.college || user.department?.college;

  return {
    id: user.id,
    names: user.names,
    firstName,
    email: user.email,
    matricNo: user.matricNo || 'CSC/2022/305',
    level: profile?.level ? `${profile.level} Level` : '100 Level',
    admissionYear: profile?.admissionYear || 2022,
    programme: programme
      ? { id: programme.id, code: programme.code, name: programme.name }
      : { id: '', code: department?.code || 'CSC', name: department?.name || 'Computer Science' },
    department: department
      ? { id: department.id, code: department.code, name: department.name }
      : { id: '', code: 'CSC', name: 'Computer Science' },
    college: college
      ? { id: college.id, code: college.code, name: college.name }
      : { id: '', code: 'CBAS', name: 'College of Basic Sciences' },
  };
}

export async function getStudentDashboard(userId: string) {
  await closeExpiredSittings();
  const student = await getStudentProfile(userId);
  const [generalSettings, examSettings] = await Promise.all([
    getGroup('general'),
    getGroup('exam'),
  ]);
  const liveExamMode = generalSettings.liveExamMode ?? true;
  const immediateResultDisplay = examSettings.immediateResultDisplay ?? false;

  // Active course enrollments for this student
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId: userId, status: 'ACTIVE' },
    select: { courseId: true },
  });
  const courseIds = enrollments.map((e) => e.courseId);

  // Sittings for student (registered in sitting OR enrolled in course)
  // Only APPROVED exams that have not been cancelled
  const sittings = await prisma.sitting.findMany({
    where: {
      status: { not: 'CANCELLED' },
      isPublic: false,
      exam: {
        status: { in: ['APPROVED', 'LOCKED'] },
      },
      OR: [
        { students: { some: { studentId: userId } } },
        ...(courseIds.length ? [{ exam: { courseId: { in: courseIds } } }] : []),
        ...(student.department?.id ? [{ exam: { course: { departmentId: student.department.id } } }] : []),
        { exam: { audience: 'INSTITUTIONAL' as const } },
      ],
    },
    include: {
      exam: {
        include: {
          course: true,
          session: true,
        },
      },
      venueRef: true,
      students: {
        where: { studentId: userId },
      },
      attempts: {
        where: { studentId: userId },
        include: {
          results: { where: { isCurrent: true } },
        },
        orderBy: { attemptNo: 'desc' },
        take: 1,
      },
    },
    orderBy: { startsAt: 'asc' },
  });

  const now = new Date();
  const live: any[] = [];
  const upcoming: any[] = [];
  const completed: any[] = [];

  for (const s of sittings) {
    const exam = s.exam;
    // If the exam is no longer approved or locked, skip it
    if (exam.status !== 'APPROVED' && exam.status !== 'LOCKED') continue;

    // Strict enrolled course filtering:
    // A student who didn't take or was not assigned to a course can NEVER see or write the exam.
    // e.g. Accounting students only see accounting exams, never computer science exams.
    if (exam.courseId) {
      const isEnrolled = courseIds.includes(exam.courseId);
      const isExplicitlySeated = s.students.length > 0;
      if (!isEnrolled && !isExplicitlySeated) {
        continue;
      }
      if (exam.course?.departmentId && student.department?.id && exam.course.departmentId !== student.department.id && !isExplicitlySeated) {
        continue;
      }
    } else if (exam.course?.departmentId && student.department?.id && exam.course.departmentId !== student.department.id && !s.students.length) {
      continue;
    }

    const courseCode = exam.course?.code || exam.title;
    const courseTitle = exam.course?.title || exam.title;
    const unit = exam.course?.units || 3;
    const venueLabel = s.venueRef?.name || s.venue || 'LASUSTECH CBT Centre';
    const seat = s.students[0]?.seatLabel || 'Seat Assigned';
    const latestAttempt = s.attempts[0];

    const isSubmitted =
      latestAttempt &&
      (latestAttempt.status === 'SUBMITTED' ||
        latestAttempt.status === 'AUTO_SUBMITTED' ||
        latestAttempt.status === 'TERMINATED');

    const inProgress = latestAttempt && latestAttempt.status === 'IN_PROGRESS';

    // Format times
    const startStr = s.startsAt.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: false });
    const endStr = s.endsAt.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', hour12: false });
    const dateLabel = s.startsAt.toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });

    if (isSubmitted) {
      const res = latestAttempt.results[0];
      const isResultReleased = res?.status === 'RELEASED';
      const canShowScore = immediateResultDisplay || isResultReleased;

      const percent = res ? Number(res.percent) : 0;
      const rawScore = res ? Number(res.rawScore) : null;
      const maxScore = res ? Number(res.maxScore) : null;
      const grade = res ? res.grade : 'P';
      completed.push({
        id: s.id,
        examId: exam.id,
        code: courseCode,
        title: courseTitle,
        status: 'completed',
        dateLabel,
        venue: venueLabel,
        unit,
        score: canShowScore
          ? (res && rawScore != null && maxScore != null
              ? `${rawScore} / ${maxScore} (${Math.round(percent)}%)`
              : (res ? `${Math.round(percent)}%` : 'Pending'))
          : 'Awaiting Administrative Release',
        rawScore: canShowScore ? rawScore : null,
        maxScore: canShowScore ? maxScore : null,
        percent: canShowScore && res ? Math.round(percent) : null,
        grade: canShowScore ? grade : '—',
        resultStatus: res?.status ?? null,
        attemptId: latestAttempt.id,
      });
      continue;
    }

    // If global exam window has ended, auto-close sitting and it is no longer live
    if (now > s.endsAt) {
      if (s.status === 'OPEN') {
        prisma.sitting.update({ where: { id: s.id }, data: { status: 'CLOSED' } }).catch(() => {});
      }
      continue;
    }

    // If live exam mode is turned off platform-wide in Admin Settings, live exams are suspended
    if (!liveExamMode) {
      if (s.status === 'SCHEDULED' || now < s.startsAt) {
        upcoming.push({
          id: s.id,
          examId: exam.id,
          code: courseCode,
          title: courseTitle,
          status: 'upcoming',
          dateLabel,
          windowLabel: `${startStr} to ${endStr}`,
          durationLabel: `${s.durationMin} min`,
          venue: venueLabel,
          unit,
        });
      }
      continue;
    }

    const graceMins = s.lateGraceMin || 15;
    const isGraceExpired = !inProgress && now > new Date(s.startsAt.getTime() + graceMins * 60_000);

    const isTimeLive = now >= s.startsAt && now <= s.endsAt;
    // An exam sitting is live if it is explicitly OPEN or its scheduled window is active (and not CLOSED)
    const isLiveWindow =
      (s.status === 'OPEN' && now <= s.endsAt) ||
      (s.status === 'SCHEDULED' && isTimeLive) ||
      (inProgress && now <= s.endsAt && s.status !== 'CLOSED');

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    const codeNotif = notifications.find(
      (n) => n.meta && typeof n.meta === 'object' && (n.meta as any).sittingId === s.id && (n.meta as any).accessCode
    );
    let accessCode = codeNotif ? (codeNotif.meta as any).accessCode : null;
    if (!accessCode && s.accessCodeHash) {
      const anyNotif = await prisma.notification.findFirst({
        where: {
          type: 'EXAM_REMINDER',
          meta: { path: ['sittingId'], equals: s.id },
        },
        select: { meta: true },
      });
      if (anyNotif?.meta && typeof anyNotif.meta === 'object' && (anyNotif.meta as any).accessCode) {
        accessCode = (anyNotif.meta as any).accessCode;
      }
    }

    if (isLiveWindow) {
      live.push({
        id: s.id,
        examId: exam.id,
        code: courseCode,
        title: courseTitle,
        status: 'live',
        dateLabel,
        windowLabel: `${startStr} to ${endStr}`,
        durationLabel: `${s.durationMin} min`,
        durationMin: s.durationMin,
        venue: venueLabel,
        seat,
        unit,
        lateText: isGraceExpired ? 'Entry grace period has expired — entry blocked' : 'Session is active — proceed to exam hall',
        isGraceExpired,
        requiresAccessCode: Boolean(s.accessCodeHash),
        accessCode,
        attemptId: latestAttempt?.id || null,
        attemptStatus: latestAttempt?.status || 'NOT_STARTED',
      });
    } else if (s.status === 'SCHEDULED' || now < s.startsAt) {
      upcoming.push({
        id: s.id,
        examId: exam.id,
        code: courseCode,
        title: courseTitle,
        status: 'upcoming',
        dateLabel,
        windowLabel: `${startStr} to ${endStr}`,
        durationLabel: `${s.durationMin} min`,
        durationMin: s.durationMin,
        venue: venueLabel,
        unit,
        requiresAccessCode: Boolean(s.accessCodeHash),
        accessCode,
      });
    }
  }

  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });

  return { student, live, upcoming, completed, notifications };
}

export async function getSittingDetails(userId: string, sittingId: string) {
  await closeExpiredSittings();
  const sitting = await prisma.sitting.findUnique({
    where: { id: sittingId },
    include: {
      exam: {
        include: {
          course: {
            include: {
              department: {
                include: {
                  college: true,
                },
              },
            },
          },
          session: true,
          sections: {
            include: {
              _count: { select: { questions: true } },
            },
          },
        },
      },
      venueRef: true,
      students: { where: { studentId: userId } },
      attempts: {
        where: { studentId: userId },
        include: {
          results: { where: { isCurrent: true } },
        },
        orderBy: { attemptNo: 'desc' },
        take: 1,
      },
    },
  });

  if (!sitting) throw Errors.notFound('Sitting');

  // Strict course assignment check: A student who didn't take the course can NEVER write the exam.
  if (sitting.exam.courseId) {
    const isExplicitlySeated = sitting.students.length > 0;
    if (!isExplicitlySeated) {
      const [enrollment, courseAssign] = await Promise.all([
        prisma.enrollment.findFirst({
          where: { studentId: userId, courseId: sitting.exam.courseId, status: 'ACTIVE' },
        }),
        prisma.courseAssignment.findFirst({
          where: { userId, courseId: sitting.exam.courseId },
        }),
      ]);
      if (!enrollment && !courseAssign) {
        throw Errors.forbidden(
          'COURSE_NOT_ASSIGNED',
          'You are not enrolled in or assigned to this course and are not permitted to write this examination.',
        );
      }
    }
  }
  if (sitting.status === 'CANCELLED') {
    throw Errors.conflict('SITTING_CANCELLED', 'This examination sitting has been cancelled.');
  }
  if (sitting.status === 'CLOSED') {
    throw Errors.conflict('SITTING_CLOSED', 'This examination sitting has ended and is closed.');
  }
  if (sitting.exam.status !== 'APPROVED' && sitting.exam.status !== 'LOCKED') {
    throw Errors.conflict('EXAM_NOT_ACTIVE', 'This examination is currently disabled or not published.');
  }

  // Strict course assignment check: A student who didn't take the course can NEVER access or write the exam.
  if (sitting.exam.courseId) {
    const isExplicitlySeated = sitting.students.length > 0;
    if (!isExplicitlySeated) {
      const [enrollment, courseAssign] = await Promise.all([
        prisma.enrollment.findFirst({
          where: { studentId: userId, courseId: sitting.exam.courseId, status: 'ACTIVE' },
        }),
        prisma.courseAssignment.findFirst({
          where: { userId, courseId: sitting.exam.courseId },
        }),
      ]);
      if (!enrollment && !courseAssign) {
        throw Errors.forbidden(
          'COURSE_NOT_ASSIGNED',
          'You are not enrolled in or assigned to this course and are not permitted to write this examination.',
        );
      }
    }
  }

  const [examSettings, generalSettings] = await Promise.all([
    getGroup('exam'),
    getGroup('general'),
  ]);

  if (generalSettings.liveExamMode === false) {
    throw Errors.conflict('EXAMS_DISABLED', 'Examinations are temporarily suspended by administrator.');
  }
  const now = new Date();
  const student = await getStudentProfile(userId);
  const exam = sitting.exam;
  const course = exam.course;
  const session = exam.session;

  const totalQuestions = exam.sections.reduce((acc, s) => acc + s._count.questions, 0);
  const latestAttempt = sitting.attempts[0];

  const isAlreadyTaken = Boolean(
    latestAttempt &&
      (latestAttempt.status === 'SUBMITTED' ||
        latestAttempt.status === 'AUTO_SUBMITTED' ||
        latestAttempt.status === 'TERMINATED')
  );

  const inProgress = latestAttempt && latestAttempt.status === 'IN_PROGRESS';
  const userRecord = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true },
  });
  const wasCreatedDuringSitting = userRecord && userRecord.createdAt >= new Date(sitting.startsAt.getTime() - 30 * 60_000);
  const graceMins = sitting.lateGraceMin || 15;
  const isGraceExpired = !inProgress && !isAlreadyTaken && !wasCreatedDuringSitting && now > new Date(sitting.startsAt.getTime() + graceMins * 60_000);
  const isWindowClosed = now > sitting.endsAt;
  const isNotStartedYet = !inProgress && (now < sitting.startsAt && sitting.status !== 'OPEN');

  return {
    sitting: {
      id: sitting.id,
      examId: exam.id,
      title: exam.title,
      courseCode: course?.code || exam.title,
      courseTitle: course?.title || exam.title,
      courseLevel: course?.level ? `${course.level} Level` : '300 Level',
      departmentName: course?.department?.name || 'Computer Science',
      collegeName: course?.department?.college?.name || 'College of Basic Sciences',
      sessionName: session?.name || '2026/2027 Academic Session',
      durationMin: sitting.durationMin,
      questionCount: totalQuestions || 40,
      venue: sitting.venueRef?.name || sitting.venue || 'CBT Centre 1',
      seatLabel: sitting.students[0]?.seatLabel || null,
      status: isWindowClosed ? 'CLOSED' : sitting.status,
      startsAt: sitting.startsAt,
      endsAt: sitting.endsAt,
      requiresAccessCode: Boolean(sitting.accessCodeHash),
      instructions: exam.instructions || null,
      antiCheatEnabled: examSettings.antiCheatEnabled,
      isAlreadyTaken,
      isGraceExpired,
      isWindowClosed,
      isNotStartedYet,
    },
    candidate: {
      id: student.id,
      names: student.names,
      matricNo: student.matricNo,
      department: student.department.name,
      college: student.college.name,
      verified: true,
    },
    attempt: latestAttempt
      ? {
          id: latestAttempt.id,
          status: latestAttempt.status,
          startedAt: latestAttempt.startedAt,
          deadlineAt: latestAttempt.deadlineAt,
          submittedAt: latestAttempt.submittedAt,
        }
      : null,
  };
}

export async function startSittingAttempt(
  userId: string,
  sittingId: string,
  accessCode?: string,
  clientIp?: string,
  sessionId?: string,
) {
  const sitting = await prisma.sitting.findUnique({
    where: { id: sittingId },
    include: {
      exam: {
        include: {
          course: true,
          sections: {
            orderBy: { position: 'asc' },
            include: {
              questions: {
                orderBy: { position: 'asc' },
                include: {
                  version: {
                    include: {
                      stemMedia: true,
                      question: true,
                      options: { orderBy: { position: 'asc' }, include: { media: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      students: { where: { studentId: userId } },
      attempts: {
        where: { studentId: userId },
        include: {
          questions: {
            orderBy: { position: 'asc' },
            include: {
              questionVersion: {
                include: {
                  stemMedia: true,
                  question: true,
                  options: { orderBy: { position: 'asc' }, include: { media: true } },
                },
              },
            },
          },
          answers: true,
        },
        orderBy: { attemptNo: 'desc' },
        take: 1,
      },
    },
  });

  if (!sitting) throw Errors.notFound('Sitting');

  // Strict course assignment check: A student who didn't take the course can NEVER write the exam.
  if (sitting.exam.courseId) {
    const isExplicitlySeated = sitting.students.length > 0;
    if (!isExplicitlySeated) {
      const [enrollment, courseAssign] = await Promise.all([
        prisma.enrollment.findFirst({
          where: { studentId: userId, courseId: sitting.exam.courseId, status: 'ACTIVE' },
        }),
        prisma.courseAssignment.findFirst({
          where: { userId, courseId: sitting.exam.courseId },
        }),
      ]);
      if (!enrollment && !courseAssign) {
        throw Errors.forbidden(
          'COURSE_NOT_ASSIGNED',
          'You are not enrolled in or assigned to this course and are not permitted to write this examination.',
        );
      }
    }
  }

  const [generalSettings, examSettings] = await Promise.all([
    getGroup('general'),
    getGroup('exam'),
  ]);
  if (generalSettings.liveExamMode === false) {
    throw Errors.conflict('EXAMS_DISABLED', 'Examinations are temporarily suspended by administrator.');
  }
  if (sitting.exam.status !== 'APPROVED' && sitting.exam.status !== 'LOCKED') {
    throw Errors.conflict('EXAM_NOT_ACTIVE', 'This examination is currently disabled or not published.');
  }

  const now = new Date();
  if (sitting.status === 'CLOSED' || sitting.status === 'CANCELLED' || now > sitting.endsAt) {
    if (sitting.status === 'OPEN' && now > sitting.endsAt) {
      await prisma.sitting.update({ where: { id: sitting.id }, data: { status: 'CLOSED' } }).catch(() => {});
    }
    throw Errors.conflict('SITTING_CLOSED', 'This exam sitting is no longer active as the scheduled time has elapsed.');
  }
  if (sitting.status === 'SCHEDULED') {
    if (now >= sitting.startsAt && now <= sitting.endsAt) {
      await prisma.sitting.update({ where: { id: sitting.id }, data: { status: 'OPEN' } }).catch(() => {});
      sitting.status = 'OPEN';
    } else {
      const scheduledTimeStr = sitting.startsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      throw Errors.conflict('SITTING_NOT_STARTED', `This examination is scheduled for ${scheduledTimeStr}. Access is not permitted until the scheduled start time.`);
    }
  } else if (sitting.status !== 'OPEN' && now < sitting.startsAt) {
    const scheduledTimeStr = sitting.startsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    throw Errors.conflict('SITTING_NOT_STARTED', `This examination is scheduled for ${scheduledTimeStr}. Access is not permitted until the scheduled start time.`);
  }

  const existing = sitting.attempts[0];
  if (existing) {
    if (existing.status === 'SUBMITTED' || existing.status === 'AUTO_SUBMITTED' || existing.status === 'TERMINATED') {
      throw Errors.conflict('EXAM_ALREADY_TAKEN', 'Your examination has already been taken and submitted. Retakes are not allowed.');
    }
    // Resume in-progress attempt
    await prisma.attemptEvent.create({
      data: {
        attemptId: existing.id,
        type: 'RESUME',
        clientTs: now,
        receivedAt: now,
      },
    }).catch(() => {});

    (existing as any).sitting = sitting;
    return await formatAttemptPaper(existing, sitting.durationMin);
  }

  // Check late-login grace period after exam schedule starts
  const candidateUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true },
  });
  const wasCreatedDuringSitting = candidateUser && candidateUser.createdAt >= new Date(sitting.startsAt.getTime() - 30 * 60_000);
  const graceMins = sitting.lateGraceMin || 15;
  if (!wasCreatedDuringSitting && now > new Date(sitting.startsAt.getTime() + graceMins * 60_000)) {
    throw Errors.conflict('GRACE_PERIOD_EXPIRED', 'The entry grace period for this examination schedule has expired. You are blocked from starting this examination.');
  }

  // Ensure candidate is registered for this sitting
  if (!sitting.students.length) {
    await prisma.sittingStudent.create({
      data: { sittingId: sitting.id, studentId: userId, seatLabel: 'Seat 42' },
    }).catch(() => {});
  }

  // Check access code if required with brute-force rate limiting
  if (sitting.accessCodeHash) {
    await checkAccessCodeRateLimit(userId, sitting.id);

    if (!accessCode) {
      throw Errors.badRequest('ACCESS_CODE_REQUIRED', 'Please enter the access code provided in your student notifications or by your invigilator.');
    }
    const cleanCode = accessCode.trim().toUpperCase();
    const matches =
      (await bcrypt.compare(cleanCode, sitting.accessCodeHash)) ||
      (await bcrypt.compare(accessCode.trim(), sitting.accessCodeHash));

    if (!matches) {
      await recordFailedAccessCode(userId, sitting.id);
      throw Errors.badRequest('INVALID_ACCESS_CODE', 'Invalid access code. Please check your notifications or consult your invigilator.');
    }

    await clearFailedAccessCode(userId, sitting.id);
  }

  // New attempt creation
  const deadlineAt = new Date(now.getTime() + sitting.durationMin * 60_000);

  // Gather questions from exam sections (Optimized with high-concurrency blueprint cache)
  type PaperQuestionItem = {
    sectionId: string;
    questionVersionId: string;
    weightedMarks: number;
    options: { position: number }[];
  };

  let candidateQuestions: PaperQuestionItem[] = [];
  let totalMarks = 0;

  const cachedPaper = sittingPaperCache.get(sittingId);
  if (cachedPaper && now.getTime() - cachedPaper.cachedAt < 120_000) {
    candidateQuestions = cachedPaper.candidateQuestions;
    totalMarks = cachedPaper.totalMarks;
  } else {
    for (const section of sitting.exam.sections) {
      for (const q of section.questions) {
        candidateQuestions.push({
          sectionId: section.id,
          questionVersionId: q.questionVersionId,
          weightedMarks: Number(q.version.marks) * Number(section.weight || 1),
          options: q.version.options,
        });
      }
    }

    // Fallback: If no questions were assigned to sections yet, pick approved questions for this course / topic
    if (candidateQuestions.length === 0) {
      let section: any = sitting.exam.sections[0];
      if (!section) {
        section = await prisma.examSection.create({
          data: {
            examId: sitting.examId,
            position: 1,
            title: 'General Section',
            timerMode: 'SHARED',
            weight: new Prisma.Decimal(1),
          },
        });
      }

      const approvedVersions = await prisma.questionVersion.findMany({
        where: {
          status: 'APPROVED',
          ...(sitting.exam.courseId ? { question: { courseId: sitting.exam.courseId } } : {}),
        },
        include: {
          options: { orderBy: { position: 'asc' } },
        },
        take: 40,
      });

      // If still none for the specific course, take any approved questions in the database
      const pool = approvedVersions.length
        ? approvedVersions
        : await prisma.questionVersion.findMany({
            where: { status: 'APPROVED' },
            include: { options: { orderBy: { position: 'asc' } } },
            take: 40,
          });

      for (const version of pool) {
        candidateQuestions.push({
          sectionId: section.id,
          questionVersionId: version.id,
          weightedMarks: Number(version.marks) || 2,
          options: version.options,
        });
      }
    }

    totalMarks = candidateQuestions.reduce((acc, q) => acc + q.weightedMarks, 0);
    sittingPaperCache.set(sittingId, {
      candidateQuestions,
      totalMarks,
      cachedAt: now.getTime(),
    });
  }

  const createdAttempt = await prisma.$transaction(async (tx) => {
    const attempt = await tx.attempt.create({
      data: {
        sittingId,
        studentId: userId,
        attemptNo: 1,
        status: 'IN_PROGRESS',
        startedAt: now,
        deadlineAt,
        questionCount: candidateQuestions.length,
        totalMarks: new Prisma.Decimal(totalMarks),
        sessionId: sessionId || null,
        ipStart: clientIp || null,
      },
    });

    const questionsToAssign = examSettings.shuffleQuestions
      ? shuffle(candidateQuestions)
      : candidateQuestions;

    if (questionsToAssign.length > 0) {
      await tx.attemptQuestion.createMany({
        data: questionsToAssign.map((q, idx) => ({
          attemptId: attempt.id,
          position: idx + 1,
          questionVersionId: q.questionVersionId,
          sectionId: q.sectionId,
          weightedMarks: new Prisma.Decimal(q.weightedMarks),
          optionOrder: examSettings.shuffleOptions
            ? shuffle(q.options.map((o) => o.position))
            : q.options.map((o) => o.position),
        })),
      });
    }

    return tx.attempt.findUnique({
      where: { id: attempt.id },
      include: {
        questions: {
          orderBy: { position: 'asc' },
          include: {
            questionVersion: {
              include: {
                stemMedia: true,
                question: true,
                options: { orderBy: { position: 'asc' }, include: { media: true } },
              },
            },
          },
        },
        answers: true,
      },
    });
  });

  if (createdAttempt) {
    await prisma.attemptEvent.create({
      data: {
        attemptId: createdAttempt.id,
        type: 'START',
        clientTs: now,
        receivedAt: now,
      },
    }).catch(() => {});
    (createdAttempt as any).sitting = sitting;
  }
  return await formatAttemptPaper(createdAttempt!, sitting.durationMin);
}

function extractText(val: any): string {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val.text === 'string') return val.text;
  return String(val);
}

async function formatAttemptPaper(attempt: any, defaultDurationMin: number) {
  const examSettings = await getGroup('exam');
  const answersMap = new Map<string, { positions: number[]; flagged: boolean }>();
  for (const ans of attempt.answers || []) {
    answersMap.set(ans.questionVersionId, {
      positions: readSelectedPositions(ans.value),
      flagged: Boolean(ans.flagged),
    });
  }

  const remainingSec = attempt.deadlineAt
    ? Math.max(0, Math.floor((new Date(attempt.deadlineAt).getTime() - Date.now()) / 1000))
    : defaultDurationMin * 60;

  const questions = (attempt.questions || []).map((q: any) => {
    const version = q.questionVersion;
    const optionsByPosition = new Map(version.options.map((opt: any) => [opt.position, opt]));
    const saved = answersMap.get(version.id);

    // Option ordering: according to candidate's assigned randomized optionOrder
    const optionOrder: number[] = q.optionOrder?.length
      ? q.optionOrder
      : version.options.map((o: any) => o.position);

    const orderedOptions = optionOrder
      .map((pos) => optionsByPosition.get(pos))
      .filter(Boolean)
      .map((opt: any, idx: number) => ({
        id: String.fromCharCode(65 + idx), // A, B, C, D label
        position: opt.position,
        text: extractText(opt.body),
        mediaUrl: opt.media ? mediaUrl(opt.media.id) : null,
      }));

    return {
      position: q.position,
      questionVersionId: version.id,
      sectionId: q.sectionId,
      text: extractText(version.stem),
      marks: Number(q.weightedMarks),
      hasMath: Boolean(version.hasMath),
      stemMediaUrl: version.stemMedia ? mediaUrl(version.stemMedia.id) : null,
      stemMedia: mediaView(version.stemMedia),
      answerFormat: version.question?.answerFormat || 'MCQ_SINGLE',
      options: orderedOptions,
      selectedPositions: saved?.positions || [],
      isFlagged: saved?.flagged || false,
    };
  });

  let studentInfo = attempt.student;
  if (!studentInfo && attempt.studentId) {
    studentInfo = await prisma.user.findUnique({
      where: { id: attempt.studentId },
      select: { id: true, matricNo: true, names: true },
    }).catch(() => null);
  }

  return {
    attemptId: attempt.id,
    sittingId: attempt.sittingId,
    studentId: attempt.studentId || studentInfo?.id || null,
    matricNo: studentInfo?.matricNo || null,
    studentName: studentInfo?.names || null,
    status: attempt.status,
    startedAt: attempt.startedAt,
    deadlineAt: attempt.deadlineAt,
    endsAt: attempt.sitting?.endsAt || null,
    antiCheatEnabled: examSettings.antiCheatEnabled,
    tabSwitchLimit: examSettings.tabSwitchLimit,
    autosaveSeconds: examSettings.autosaveSeconds,
    heartbeatSeconds: examSettings.heartbeatSeconds,
    courseCode: attempt.sitting?.exam?.course?.code || attempt.sitting?.exam?.title || 'CBT Course',
    courseTitle: attempt.sitting?.exam?.course?.title || attempt.sitting?.exam?.title || 'CBT Examination',
    instructions: attempt.sitting?.exam?.instructions || null,
    remainingSec,
    totalQuestions: questions.length,
    questions,
  };
}

export async function getAttemptPaper(userId: string, attemptId: string) {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, studentId: userId },
    include: {
      sitting: {
        include: {
          exam: {
            include: {
              course: true,
            },
          },
        },
      },
      questions: {
        orderBy: { position: 'asc' },
        include: {
          questionVersion: {
            include: {
              stemMedia: true,
              question: true,
              options: { orderBy: { position: 'asc' }, include: { media: true } },
            },
          },
        },
      },
      answers: true,
    },
  });

  if (!attempt) throw Errors.notFound('Attempt');

  return await formatAttemptPaper(attempt, attempt.sitting.durationMin);
}

export async function saveAnswer(
  userId: string,
  attemptId: string,
  body: {
    questionVersionId: string;
    selectedPositions: number[];
    flagged?: boolean;
    clientSeq?: number;
  },
) {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, studentId: userId },
    select: { id: true, status: true, deadlineAt: true },
  });

  if (!attempt) throw Errors.notFound('Attempt');
  if (attempt.status !== 'IN_PROGRESS') {
    throw Errors.conflict('ATTEMPT_NOT_ACTIVE', 'This exam attempt is no longer active.');
  }

  // Grace period 30 seconds for network latency
  if (attempt.deadlineAt && Date.now() > new Date(attempt.deadlineAt).getTime() + 30_000) {
    throw Errors.conflict('TIME_EXPIRED', 'The examination deadline has passed.');
  }

  const now = new Date();
  const clientSeq = BigInt(body.clientSeq || Date.now());

  await prisma.$transaction(async (tx) => {
    await tx.answer.upsert({
      where: {
        attemptId_questionVersionId: {
          attemptId,
          questionVersionId: body.questionVersionId,
        },
      },
      create: {
        attemptId,
        questionVersionId: body.questionVersionId,
        value: { selected: body.selectedPositions },
        flagged: Boolean(body.flagged),
        clientSeq,
        answeredAt: now,
      },
      update: {
        value: { selected: body.selectedPositions },
        flagged: Boolean(body.flagged),
        clientSeq,
        answeredAt: now,
      },
    });

    await tx.answerEvent.create({
      data: {
        attemptId,
        questionVersionId: body.questionVersionId,
        value: { selected: body.selectedPositions },
        clientSeq,
        clientTs: now,
      },
    });
  });

  return { success: true, savedAt: now.toISOString() };
}

export async function submitAttempt(
  userId: string,
  attemptId: string,
  options: { endedReason?: 'STUDENT_SUBMIT' | 'AUTO_SUBMIT' } = {},
) {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, studentId: userId },
    include: {
      sitting: {
        include: {
          exam: {
            include: {
              course: true,
            },
          },
        },
      },
      student: true,
      results: { where: { isCurrent: true } },
    },
  });

  if (!attempt) throw Errors.notFound('Attempt');

  const refCode = `LASU-${attempt.id.slice(0, 4).toUpperCase()}-${attempt.id.slice(-4).toUpperCase()}`;
  const courseCode = attempt.sitting.exam.course?.code || attempt.sitting.exam.title;
  const courseTitle = attempt.sitting.exam.course?.title || attempt.sitting.exam.title;

  let scoreSummary: ScoreSummary;

  if (attempt.status === 'SUBMITTED' || attempt.status === 'AUTO_SUBMITTED') {
    const existingResult = attempt.results[0];
    scoreSummary = {
      rawScore: Number(existingResult?.rawScore || 0),
      maxScore: Number(existingResult?.maxScore || 0),
      percent: Number(existingResult?.percent || 0),
      grade: (existingResult?.grade as any) || 'A',
      gradeLabel: null,
      passed: Number(existingResult?.percent || 0) >= 50,
    };
  } else {
    scoreSummary = await prisma.$transaction(async (tx) => {
      return scoreAttempt(tx, attemptId, {
        auto: options.endedReason === 'AUTO_SUBMIT',
        endedReason: options.endedReason || 'STUDENT_SUBMIT',
      });
    });
  }

  const examSettings = await getGroup('exam');
  const allowImmediate = examSettings.immediateResultDisplay ?? false;

  return {
    refCode,
    attemptId: attempt.id,
    sittingId: attempt.sittingId,
    studentName: attempt.student.names,
    matricNo: attempt.student.matricNo || 'N/A',
    courseCode,
    courseTitle,
    submittedAt: new Date().toISOString(),
    score: allowImmediate ? scoreSummary : null,
  };
}

export async function getStudentResults(userId: string) {
  const student = await getStudentProfile(userId);
  const examSettings = await getGroup('exam');
  const allowImmediate = examSettings.immediateResultDisplay;

  // Fetch all current Results for attempts by this student
  // All results must pass through admin before publishing (status === 'RELEASED') except when immediateResultDisplay is enabled
  const results = await prisma.result.findMany({
    where: {
      isCurrent: true,
      attempt: {
        studentId: userId,
      },
      ...(!allowImmediate ? { status: 'RELEASED' } : {}),
    },
    include: {
      attempt: {
        include: {
          sitting: {
            include: {
              exam: {
                include: {
                  course: true,
                  session: true,
                },
              },
            },
          },
        },
      },
    },
    orderBy: { scoredAt: 'desc' },
  });

  type ResultItem = {
    code: string;
    title: string;
    attemptId?: string;
    examScore: number;
    rawScore: number;
    maxScore: number;
    percent: number;
    scoreLabel: string;
    remark: 'Pass' | 'Fail';
    passed: boolean;
    level: string;
    semester: string;
    session: string;
    scoredAt: string;
    status: string;
  };

  const list: ResultItem[] = [];

  for (const r of results) {
    const exam = r.attempt.sitting.exam;
    const course = exam.course;
    const percent = Math.round(Number(r.percent));
    const rawScore = Number(r.rawScore);
    const maxScore = Number(r.maxScore);
    const passThreshold = exam.passMark != null ? Number(exam.passMark) : 40;
    const passed = percent >= passThreshold;

    list.push({
      code: course?.code || exam.title,
      title: course?.title || exam.title,
      attemptId: r.attempt.id,
      examScore: percent,
      rawScore,
      maxScore,
      percent,
      scoreLabel: `${rawScore} / ${maxScore}`,
      remark: passed ? 'Pass' : 'Fail',
      passed,
      level: course?.level ? `${course.level} Level` : 'Undergraduate',
      semester: 'Harmattan (1st)',
      session: exam.session?.name || '2026/2027',
      scoredAt: r.scoredAt.toISOString(),
      status: r.status,
    });
  }

  const dbSessions = await prisma.academicSession.findMany({
    select: { name: true, isCurrent: true },
    orderBy: { startsOn: 'desc' },
  });
  const sessionSet = new Set<string>();
  for (const r of list) {
    if (r.session) sessionSet.add(r.session);
  }
  const currentDbSession = dbSessions.find((s) => s.isCurrent)?.name;
  if (currentDbSession && list.some((r) => r.session === currentDbSession)) {
    sessionSet.add(currentDbSession);
  }
  if (sessionSet.size === 0 && currentDbSession) {
    sessionSet.add(currentDbSession);
  }
  const availableSessions = Array.from(sessionSet);

  return {
    student,
    results: list,
    availableSessions,
    currentSession: currentDbSession || availableSessions[0] || undefined,
    summary: {
      totalCourses: list.length,
      passedCourses: list.filter((l) => l.passed).length,
      failedCourses: list.filter((l) => !l.passed).length,
    },
  };
}

export async function recordHeartbeat(userId: string, attemptId: string, payload?: any) {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, studentId: userId },
    select: {
      id: true,
      status: true,
      deadlineAt: true,
      extraMinutes: true,
      pausedAt: true,
    },
  });

  if (!attempt) throw Errors.notFound('Attempt');

  const now = new Date();
  const lastWrite = lastHeartbeatEventDbWrite.get(attemptId) || 0;
  // Write HEARTBEAT to attempt_events at most once per 60 seconds per attempt to prevent write log explosion
  if (now.getTime() - lastWrite >= 60_000) {
    lastHeartbeatEventDbWrite.set(attemptId, now.getTime());
    prisma.attemptEvent.create({
      data: {
        attemptId,
        type: 'HEARTBEAT',
        clientTs: now,
        receivedAt: now,
        payload: payload?.meta || null,
      },
    }).catch(() => {});
  }

  // Fetch latest intervention message sent by invigilator if any
  const latestMessage = await prisma.intervention.findFirst({
    where: { attemptId, action: 'MESSAGE' },
    orderBy: { createdAt: 'desc' },
  });

  return {
    status: attempt.status,
    deadlineAt: attempt.deadlineAt,
    extraMinutes: attempt.extraMinutes,
    isPaused: attempt.status === 'PAUSED',
    message: latestMessage
      ? {
          id: latestMessage.id,
          text: (latestMessage.params as any)?.message || latestMessage.reason,
          sentAt: latestMessage.createdAt,
        }
      : null,
  };
}

export async function recordAttemptEvent(
  userId: string,
  attemptId: string,
  body: { type: string; payload?: any; count?: number },
) {
  const attempt = await prisma.attempt.findFirst({
    where: { id: attemptId, studentId: userId },
    select: { id: true, status: true, sittingId: true, studentId: true },
  });

  if (!attempt) throw Errors.notFound('Attempt');

  const now = new Date();
  const eventType = body.type || 'CLIENT_EVENT';

  await prisma.attemptEvent.create({
    data: {
      attemptId,
      type: eventType,
      clientTs: now,
      receivedAt: now,
      payload: body.payload || (body.count ? { count: body.count } : null),
    },
  }).catch(() => {});

  if (eventType === 'TAB_SWITCH') {
    await prisma.flag.create({
      data: {
        attemptId,
        ruleKey: 'TAB_SWITCH',
        severity: (body.count && body.count >= 2) ? 'HIGH' : 'WARNING',
        details: { switchCount: body.count || 1, clientTs: now.toISOString() },
      },
    }).catch(() => {});

    // Broadcast anti-cheat violation in real-time to sitting invigilators
    void publishRealtimeEvent({
      event: 'attempt.flagged',
      target: {
        rooms: [`sitting:${attempt.sittingId}`],
      },
      data: {
        sittingId: attempt.sittingId,
        attemptId,
        studentId: attempt.studentId,
        ruleKey: 'TAB_SWITCH',
        severity: (body.count && body.count >= 2) ? 'HIGH' : 'WARNING',
        count: body.count || 1,
        clientTs: now.toISOString(),
      },
    });
  }

  return { success: true };
}

export async function getStudentAttemptScript(userId: string, attemptId: string) {
  const attempt = await prisma.attempt.findUnique({
    where: { id: attemptId },
    include: {
      sitting: true,
      results: {
        where: { isCurrent: true },
        select: { status: true },
      },
    },
  });

  if (!attempt || attempt.studentId !== userId) {
    throw Errors.notFound('Attempt');
  }

  const examSettings = await getGroup('exam');
  const allowImmediate = Boolean(examSettings.immediateResultDisplay);
  const isReleased = attempt.results.some((r) => r.status === 'RELEASED');

  if (!allowImmediate && !isReleased) {
    throw Errors.forbidden(
      'RESULT_NOT_RELEASED',
      'The examination script cannot be reviewed until official results are released by the administrator.',
    );
  }

  return await buildAttemptScriptPayload(attemptId);
}
