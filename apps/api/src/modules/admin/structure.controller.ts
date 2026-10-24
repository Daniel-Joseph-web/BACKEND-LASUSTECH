import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { Errors } from '../../lib/errors';
import { actorFrom, writeAudit, Tx } from '../../lib/audit';
import { blankToNull, orConflict, uuidParam } from '../../lib/http';

const code = z.string().trim().min(1).max(20).transform((s) => s.toUpperCase().replace(/\s+/g, ''));
const courseCode = z.string().trim().min(2).max(20).transform((s) => s.toUpperCase().replace(/\s+/g, ' '));
const name = z.string().trim().min(2).max(120);
const person = z.preprocess(blankToNull, z.string().trim().max(120).nullable().optional());
const levelsFor = (years: number) => Array.from({ length: years }, (_, i) => (i + 1) * 100);

// ---------- tree ----------
export const getStructure = async (_req: Request, res: Response) => {
  const colleges = await prisma.college.findMany({
    orderBy: { name: 'asc' },
    include: {
      departments: {
        orderBy: { name: 'asc' },
        include: {
          programmes: { orderBy: { name: 'asc' } },
          _count: { select: { courses: true, members: true } },
        },
      },
    },
  });

  res.json({
    data: colleges.map((f) => ({
      id: f.id,
      code: f.code,
      name: f.name,
      dean: f.dean,
      active: f.active,
      departments: f.departments.map((d) => ({
        id: d.id,
        code: d.code,
        name: d.name,
        headName: d.headName,
        collegeId: d.collegeId,
        active: d.active,
        courseCount: d._count.courses,
        userCount: d._count.members,
        programmes: d.programmes.map((p) => ({
          id: p.id,
          code: p.code,
          name: p.name,
          award: p.award,
          durationYears: p.durationYears,
          active: p.active,
          levels: levelsFor(p.durationYears),
        })),
      })),
    })),
  });
};

// ---------- college ----------
const collegeCreate = z.object({ code, name, dean: person });
// `active` is only settable after creation: archiving is a deliberate action on
// an existing record, never a property of a brand-new one.
const collegeUpdate = collegeCreate.partial().extend({ active: z.boolean().optional() });

export const createCollege = async (req: Request, res: Response) => {
  const body = collegeCreate.parse(req.body);
  const actor = actorFrom(req, res);

  const f = await orConflict('A college with that code already exists.', () =>
    prisma.$transaction(async (tx) => {
      const created = await tx.college.create({
        data: {
          code: body.code,
          name: body.name,
          dean: body.dean ?? null,
        },
      });
      await writeAudit(tx, actor, {
        action: 'college.create',
        targetType: 'College',
        targetId: created.id,
        after: { code: created.code, name: created.name, dean: created.dean },
      });
      return created;
    }),
  );

  res.status(201).json({ data: f });
};

export const updateCollege = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = collegeUpdate.parse(req.body);
  const before = await prisma.college.findUnique({ where: { id } });
  if (!before) throw Errors.notFound('College');

  const actor = actorFrom(req, res);

  const f = await orConflict('A college with that code already exists.', () =>
    prisma.$transaction(async (tx) => {
      const u = await tx.college.update({ where: { id }, data: body });
      await writeAudit(tx, actor, {
        action: 'college.update',
        targetType: 'College',
        targetId: id,
        before: { code: before.code, name: before.name, dean: before.dean, active: before.active },
        after: { code: u.code, name: u.name, dean: u.dean, active: u.active },
      });
      return u;
    }),
  );

  res.json({ data: f });
};

export const deleteCollege = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const f = await prisma.college.findUnique({
    where: { id },
    include: { _count: { select: { departments: true } } },
  });
  if (!f) throw Errors.notFound('College');
  if (f._count.departments) {
    throw Errors.conflict('IN_USE', 'Remove or move this collegeâ€™s departments first, or archive the college.');
  }

  const actor = actorFrom(req, res);

  await prisma.$transaction(async (tx) => {
    await tx.college.delete({ where: { id } });
    await writeAudit(tx, actor, {
      action: 'college.delete',
      targetType: 'College',
      targetId: id,
      before: { code: f.code, name: f.name },
    });
  });

  res.status(204).end();
};

// ---------- department ----------
const deptCreate = z.object({
  collegeId: z.uuid(),
  code,
  name,
  headName: person,
});
const deptUpdate = deptCreate.partial().extend({ active: z.boolean().optional() });

export const createDepartment = async (req: Request, res: Response) => {
  const body = deptCreate.parse(req.body);
  const college = await prisma.college.findUnique({
    where: { id: body.collegeId },
    select: { id: true, active: true },
  });
  if (!college) throw Errors.notFound('College');
  if (!college.active) {
    throw Errors.conflict('ARCHIVED', 'Restore this college before adding departments.');
  }

  const actor = actorFrom(req, res);

  const d = await orConflict('That department code already exists in this college.', () =>
    prisma.$transaction(async (tx) => {
      const created = await tx.department.create({
        data: {
          collegeId: body.collegeId,
          code: body.code,
          name: body.name,
          headName: body.headName ?? null,
        },
      });
      await writeAudit(tx, actor, {
        action: 'department.create',
        targetType: 'Department',
        targetId: created.id,
        after: { code: created.code, name: created.name, headName: created.headName },
      });
      return created;
    }),
  );

  res.status(201).json({ data: d });
};

export const updateDepartment = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = deptUpdate.parse(req.body);
  const before = await prisma.department.findUnique({ where: { id } });
  if (!before) throw Errors.notFound('Department');

  const actor = actorFrom(req, res);

  const d = await orConflict('That department code already exists in this college.', () =>
    prisma.$transaction(async (tx) => {
      const u = await tx.department.update({ where: { id }, data: body });
      await writeAudit(tx, actor, {
        action: 'department.update',
        targetType: 'Department',
        targetId: id,
        before: { code: before.code, name: before.name, headName: before.headName, active: before.active },
        after: { code: u.code, name: u.name, headName: u.headName, active: u.active },
      });
      return u;
    }),
  );

  res.json({ data: d });
};

export const deleteDepartment = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const d = await prisma.department.findUnique({
    where: { id },
    include: { _count: { select: { programmes: true, courses: true, members: true } } },
  });
  if (!d) throw Errors.notFound('Department');

  const c = d._count;
  if (c.programmes || c.courses || c.members) {
    throw Errors.conflict(
      'IN_USE',
      `This department still has ${c.programmes} programme(s), ${c.courses} course(s) and ${c.members} user(s). Archive it instead if it is no longer offered.`,
    );
  }

  const actor = actorFrom(req, res);

  await prisma.$transaction(async (tx) => {
    await tx.department.delete({ where: { id } });
    await writeAudit(tx, actor, {
      action: 'department.delete',
      targetType: 'Department',
      targetId: id,
      before: { code: d.code, name: d.name },
    });
  });

  res.status(204).end();
};

// ---------- programme ----------
const progCreate = z.object({
  departmentId: z.uuid(),
  code,
  name,
  award: z.string().trim().min(1).max(30),
  durationYears: z.coerce.number().int().min(1).max(7),
});
const progUpdate = progCreate.omit({ departmentId: true }).partial().extend({ active: z.boolean().optional() });

export const createProgramme = async (req: Request, res: Response) => {
  const body = progCreate.parse(req.body);
  const department = await prisma.department.findUnique({
    where: { id: body.departmentId },
    select: { id: true, active: true },
  });
  if (!department) throw Errors.notFound('Department');
  if (!department.active) {
    throw Errors.conflict('ARCHIVED', 'Restore this department before adding programmes.');
  }

  const actor = actorFrom(req, res);

  const p = await orConflict('That programme code already exists in this department.', () =>
    prisma.$transaction(async (tx) => {
      const created = await tx.programme.create({
        data: {
          code: body.code,
          name: body.name,
          award: body.award,
          durationYears: body.durationYears,
          department: {
            connect: { id: body.departmentId },
          },
        },
      });
      await writeAudit(tx, actor, {
        action: 'programme.create',
        targetType: 'Programme',
        targetId: created.id,
        after: {
          code: created.code,
          name: created.name,
          award: created.award,
          durationYears: created.durationYears,
        },
      });
      return created;
    }),
  );

  res.status(201).json({ data: p });
};

export const updateProgramme = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = progUpdate.parse(req.body);
  const before = await prisma.programme.findUnique({ where: { id } });
  if (!before) throw Errors.notFound('Programme');

  const actor = actorFrom(req, res);

  const p = await orConflict('That programme code already exists in this department.', () =>
    prisma.$transaction(async (tx) => {
      const u = await tx.programme.update({ where: { id }, data: body });
      await writeAudit(tx, actor, {
        action: 'programme.update',
        targetType: 'Programme',
        targetId: id,
        before: {
          code: before.code,
          name: before.name,
          award: before.award,
          durationYears: before.durationYears,
          active: before.active,
        },
        after: {
          code: u.code,
          name: u.name,
          award: u.award,
          durationYears: u.durationYears,
          active: u.active,
        },
      });
      return u;
    }),
  );

  res.json({ data: p });
};

export const deleteProgramme = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const p = await prisma.programme.findUnique({
    where: { id },
    include: { _count: { select: { studentProfiles: true } } },
  });
  if (!p) throw Errors.notFound('Programme');
  if (p._count.studentProfiles) {
    throw Errors.conflict(
      'IN_USE',
      `${p._count.studentProfiles} student(s) are enrolled in this programme. Archive it instead if it is no longer offered.`,
    );
  }

  const actor = actorFrom(req, res);

  await prisma.$transaction(async (tx) => {
    await tx.programmeCourse.deleteMany({ where: { programmeId: id } });
    await tx.programme.delete({ where: { id } });
    await writeAudit(tx, actor, {
      action: 'programme.delete',
      targetType: 'Programme',
      targetId: id,
      before: { code: p.code, name: p.name },
    });
  });

  res.status(204).end();
};

// ---------- courses ----------
const courseBody = z.object({
  departmentId: z.uuid(),
  code: courseCode,
  title: name,
  units: z.coerce.number().int().min(0).max(12).default(3),
  level: z.coerce.number().int().min(100).max(900).multipleOf(100),
  defaultSemester: z.enum(['FIRST', 'SECOND']),
  active: z.boolean().default(true),
  lecturerIds: z.array(z.uuid()).max(10).optional(),
});

async function setLecturers(tx: Tx, courseId: string, userIds: string[]) {
  let session = await tx.academicSession.findFirst({
    where: { isCurrent: true },
    select: { id: true },
  });
  if (!session) {
    session = await tx.academicSession.findFirst({
      where: { closedAt: null },
      orderBy: { startsOn: 'desc' },
      select: { id: true },
    }) || await tx.academicSession.findFirst({
      orderBy: { startsOn: 'desc' },
      select: { id: true },
    });
  }
  const ids = [...new Set(userIds)];

  if (!session) {
    if (ids.length) {
      throw Errors.conflict('NO_SESSION', 'Please create an academic session before assigning lecturers.');
    }
    return;
  }

  if (ids.length) {
    const validUsers = await tx.user.findMany({
      where: {
        id: { in: ids },
        status: 'ACTIVE',
      },
      include: {
        roles: { include: { role: true } },
      },
    });
    if (validUsers.length !== ids.length) {
      throw Errors.badRequest('INVALID_LECTURER', 'One or more assigned lecturers could not be found or are inactive.');
    }

    const lecturerRole = await tx.role.findUnique({ where: { key: 'LECTURER' } });
    if (lecturerRole) {
      for (const u of validUsers) {
        const hasLecturer = u.roles.some((r) => r.role.key === 'LECTURER');
        if (!hasLecturer) {
          await tx.userRole.create({
            data: { userId: u.id, roleId: lecturerRole.id, scopeType: 'GLOBAL' },
          }).catch(() => {});
        }
      }
    }
  }

  await tx.courseAssignment.deleteMany({
    where: { courseId, sessionId: session.id, role: 'LECTURER' },
  });

  if (ids.length) {
    await tx.courseAssignment.createMany({
      data: ids.map((userId) => ({
        courseId,
        userId,
        sessionId: session.id,
        role: 'LECTURER' as const,
      })),
      skipDuplicates: true,
    });
  }
}

async function lecturersByCourse(courseIds: string[]) {
  let session = await prisma.academicSession.findFirst({
    where: { isCurrent: true },
    select: { id: true },
  });
  if (!session) {
    session = await prisma.academicSession.findFirst({
      where: { closedAt: null },
      orderBy: { startsOn: 'desc' },
      select: { id: true },
    }) || await prisma.academicSession.findFirst({
      orderBy: { startsOn: 'desc' },
      select: { id: true },
    });
  }
  const map = new Map<string, { id: string; names: string }[]>();
  if (!session || !courseIds.length) return map;

  const rows = await prisma.courseAssignment.findMany({
    where: {
      courseId: { in: courseIds },
      sessionId: session.id,
      role: 'LECTURER',
    },
    select: {
      courseId: true,
      user: { select: { id: true, names: true } },
    },
  });

  for (const r of rows) {
    map.set(r.courseId, [...(map.get(r.courseId) ?? []), r.user]);
  }
  return map;
}

/** Returns a map of courseId → number of ACTIVE enrolled students in the current/latest session. */
async function studentCountByCourse(courseIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!courseIds.length) return map;

  // Resolve current or most-recent academic session
  let session = await prisma.academicSession.findFirst({
    where: { isCurrent: true },
    select: { id: true },
  });
  if (!session) {
    session = await prisma.academicSession.findFirst({
      where: { closedAt: null },
      orderBy: { startsOn: 'desc' },
      select: { id: true },
    }) || await prisma.academicSession.findFirst({
      orderBy: { startsOn: 'desc' },
      select: { id: true },
    });
  }
  if (!session) return map;

  const counts = await prisma.enrollment.groupBy({
    by: ['courseId'],
    where: {
      courseId: { in: courseIds },
      sessionId: session.id,
      status: 'ACTIVE',
    },
    _count: { studentId: true },
  });

  for (const row of counts) {
    map.set(row.courseId, row._count.studentId);
  }
  return map;
}

const presentCourse = (
  c: {
    id: string;
    code: string;
    title: string;
    units: number;
    level: number;
    defaultSemester: string;
    active: boolean;
    departmentId: string;
    department?: { id: string; code: string; name: string } | null;
  },
  lecturers: { id: string; names: string }[],
  studentCount = 0,
) => ({
  id: c.id,
  code: c.code,
  title: c.title,
  units: c.units,
  level: c.level,
  semester: c.defaultSemester,
  active: c.active,
  departmentId: c.departmentId,
  department: c.department ? { id: c.department.id, code: c.department.code, name: c.department.name } : null,
  lecturers,
  studentCount,
});

export const listCourses = async (req: Request, res: Response) => {
  const q = z
    .object({
      departmentId: z.preprocess(
        (val) => (val === '' || val === null || val === undefined ? undefined : val),
        z.string().uuid().optional(),
      ),
      level: z.coerce.number().int().optional(),
      search: z.string().trim().max(80).optional(),
      status: z.enum(['active', 'archived']).optional(),
    })
    .parse(req.query);

  const courses = await prisma.course.findMany({
    where: {
      departmentId: q.departmentId,
      level: q.level,
      active: q.status ? q.status === 'active' : undefined,
      ...(q.search
        ? {
            OR: [
              { code: { contains: q.search, mode: 'insensitive' } },
              { title: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      department: { select: { id: true, code: true, name: true } },
    },
    orderBy: [{ level: 'asc' }, { code: 'asc' }],
    take: 500,
  });

  const courseIds = courses.map((c) => c.id);
  const [lect, studentCounts] = await Promise.all([
    lecturersByCourse(courseIds),
    studentCountByCourse(courseIds),
  ]);
  res.json({
    data: courses.map((c) => presentCourse(c, lect.get(c.id) ?? [], studentCounts.get(c.id) ?? 0)),
  });
};

export const createCourse = async (req: Request, res: Response) => {
  const { lecturerIds, ...data } = courseBody.parse(req.body);
  const department = await prisma.department.findUnique({
    where: { id: data.departmentId },
    select: { id: true, active: true },
  });
  if (!department) throw Errors.notFound('Department');
  if (!department.active) {
    throw Errors.conflict('ARCHIVED', 'Restore this department before adding courses.');
  }

  const actor = actorFrom(req, res);

  const c = await orConflict('That course code already exists in this department.', () =>
    prisma.$transaction(async (tx) => {
      const created = await tx.course.create({
        data: {
          code: data.code,
          title: data.title,
          units: data.units,
          level: data.level,
          defaultSemester: data.defaultSemester,
          active: data.active,
          department: {
            connect: { id: data.departmentId },
          },
        },
      });
      if (lecturerIds?.length) await setLecturers(tx, created.id, lecturerIds);
      await writeAudit(tx, actor, {
        action: 'course.create',
        targetType: 'Course',
        targetId: created.id,
        after: {
          code: created.code,
          title: created.title,
          level: created.level,
          lecturerIds,
        },
      });
      return created;
    }),
  );

  res.status(201).json({
    data: presentCourse(c, (await lecturersByCourse([c.id])).get(c.id) ?? [], 0),
  });
};

export const updateCourse = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const { lecturerIds, ...data } = courseBody.partial().parse(req.body);
  const before = await prisma.course.findUnique({ where: { id } });
  if (!before) throw Errors.notFound('Course');

  // Only a move to a different department needs the archived-parent check, so
  // courses already sitting in an archived department can still be edited.
  if (data.departmentId && data.departmentId !== before.departmentId) {
    const department = await prisma.department.findUnique({
      where: { id: data.departmentId },
      select: { id: true, active: true },
    });
    if (!department) throw Errors.notFound('Department');
    if (!department.active) {
      throw Errors.conflict('ARCHIVED', 'Restore this department before moving courses into it.');
    }
  }

  const actor = actorFrom(req, res);

  const c = await orConflict('That course code already exists in this department.', () =>
    prisma.$transaction(async (tx) => {
      const u = await tx.course.update({ where: { id }, data });
      if (lecturerIds) await setLecturers(tx, id, lecturerIds);
      await writeAudit(tx, actor, {
        action: 'course.update',
        targetType: 'Course',
        targetId: id,
        before: {
          code: before.code,
          title: before.title,
          level: before.level,
          active: before.active,
        },
        after: {
          code: u.code,
          title: u.title,
          level: u.level,
          active: u.active,
          lecturerIds,
        },
      });
      return u;
    }),
  );

  res.json({
    data: presentCourse(c, (await lecturersByCourse([c.id])).get(c.id) ?? [], (await studentCountByCourse([c.id])).get(c.id) ?? 0),
  });
};

export const deleteCourse = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const c = await prisma.course.findUnique({ where: { id } });
  if (!c) throw Errors.notFound('Course');

  const actor = actorFrom(req, res);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.enrollment.deleteMany({ where: { courseId: id } });
      await tx.courseAssignment.deleteMany({ where: { courseId: id } });
      await tx.programmeCourse.deleteMany({ where: { courseId: id } });
      await tx.topic.deleteMany({ where: { courseId: id } });
      await tx.course.delete({ where: { id } });
      await writeAudit(tx, actor, {
        action: 'course.delete',
        targetType: 'Course',
        targetId: id,
        before: { code: c.code, title: c.title },
      });
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2003') {
      throw Errors.conflict(
        'IN_USE',
        'This course has questions, exams or enrolments. Archive it instead of deleting.',
      );
    }
    throw e;
  }

  res.status(204).end();
};