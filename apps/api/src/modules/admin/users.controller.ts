import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';
import { Prisma } from '@lasustech-cbt/db';
import { prisma } from '../../lib/prisma';
import { AppError, Errors } from '../../lib/errors';
import { actorFrom, writeAudit, Tx } from '../../lib/audit';
import { setUserRoles } from '../../lib/identity';
import { ROLE_PRIORITY, RoleKey } from '../auth/tokens';
import { blankToNull, blankToUndef, pageMeta, pageShape, sendCsv, toCsv, uuidParam } from '../../lib/http';

// Exactly the three institution roles. The database enforces the same list in
// app_set_roles(); this constant only keeps the API's validation message close
// to the form. See apps/api/src/modules/auth/tokens.ts.
const ROLES = ['ADMIN', 'LECTURER', 'STUDENT'] as const;
const STATUSES = ['INVITED', 'ACTIVE', 'LOCKED', 'DEACTIVATED'] as const;
const USER_ROUNDS = 12; // passwords chosen by a human (or surname pattern)
const TEMP_ROUNDS = 10; // random 12-char passwords: high entropy, cheaper hashing is fine

// ---------- helpers ----------
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const tempPassword = (len = 12) =>
  Array.from({ length: len }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');

/**
 * Student default password: first name + last digits of matric number (in lowercase).
 * Nigerian roster naming convention: [Surname] [FirstName] [MiddleName]
 * Example: "daniel joseph oluwafemi" + "csc/2022/098" → "joseph098"
 * Pads to 8 chars if still short (API min length).
 */
export function studentPassword(names: string, matricNo?: string | null): string {
  const parts = names.trim().split(/\s+/).filter(Boolean);
  // Nigerian roster format: parts[0] is surname, parts[1] is first name, parts[2] is middle name
  const rawFirstName = parts.length > 1 ? parts[1]! : parts[0] ?? 'student';
  const firstName = rawFirstName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const digits = (matricNo ?? '').replace(/\D/g, '');
  const lastDigits = (digits.slice(-3) || '000').padStart(3, '0');
  const pw = `${firstName}${lastDigits}`;
  return pw.length >= 8 ? pw : pw.padEnd(8, '0');
}

const optStr = (max: number) => z.preprocess(blankToUndef, z.string().trim().max(max).optional());
const optUpper = (max: number) => z.preprocess(blankToUndef, z.string().trim().toUpperCase().max(max).optional());
const optEmail = z.preprocess(blankToUndef, z.string().trim().toLowerCase().email().max(120).optional());
const optUuid = z.preprocess(blankToUndef, z.uuid().optional());
const nullStr = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const nullUpper = (max: number) => z.preprocess(blankToNull, z.string().trim().toUpperCase().max(max).nullable().optional());
const nullEmail = z.preprocess(blankToNull, z.string().trim().toLowerCase().email().max(120).nullable().optional());
const nullUuid = z.preprocess(blankToNull, z.uuid().nullable().optional());

const userSelect = {
  id: true,
  names: true,
  matricNo: true,
  staffId: true,
  email: true,
  phone: true,
  status: true,
  departmentId: true,
  lastLoginAt: true,
  createdAt: true,
  department: { select: { id: true, name: true, code: true } },
  roles: { select: { scopeType: true, role: { select: { key: true } } } },
} satisfies Prisma.UserSelect;
type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

// GLOBAL grants are the only institutional authority (see auth.service.ts).
const rolesOf = (u: UserRow): RoleKey[] => [
  ...new Set(
    u.roles.filter((r) => r.scopeType === 'GLOBAL').map((r) => r.role.key as RoleKey),
  ),
];
const identifierOf = (u: { matricNo: string | null; staffId: string | null; email: string | null }) =>
  u.matricNo ?? u.staffId ?? u.email ?? '';

const present = (u: UserRow) => {
  const roles = rolesOf(u);
  return {
    id: u.id,
    names: u.names,
    matricNo: u.matricNo,
    staffId: u.staffId,
    email: u.email,
    phone: u.phone,
    status: u.status,
    departmentId: u.departmentId,
    department: u.department,
    roles,
    primaryRole: ROLE_PRIORITY.find((r) => roles.includes(r)) ?? null,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
};
const auditView = (u: UserRow) => ({
  names: u.names,
  matricNo: u.matricNo,
  staffId: u.staffId,
  email: u.email,
  status: u.status,
  departmentId: u.departmentId,
  roles: rolesOf(u),
});

type Ident = {
  roles: readonly string[];
  matricNo?: string | null;
  staffId?: string | null;
  email?: string | null;
};
function identityIssue(v: Ident): { field: string; message: string } | null {
  const student = v.roles.includes('STUDENT');
  if (student && v.roles.length > 1) {
    return { field: 'roles', message: 'A student account cannot also hold staff roles.' };
  }
  if (student && !v.matricNo) {
    return { field: 'matricNo', message: 'Students need a matric number.' };
  }
  if (!student && !v.staffId && !v.email) {
    return { field: 'staffId', message: 'Staff need a staff ID or an email address.' };
  }
  return null;
}

async function assertUnique(
  v: { matricNo?: string | null; staffId?: string | null; email?: string | null },
  excludeId?: string,
) {
  const or: Prisma.UserWhereInput[] = [];
  if (v.matricNo) or.push({ matricNo: { equals: v.matricNo, mode: 'insensitive' } });
  if (v.staffId) or.push({ staffId: { equals: v.staffId, mode: 'insensitive' } });
  if (v.email) or.push({ email: { equals: v.email, mode: 'insensitive' } });
  if (!or.length) return;
  const hit = await prisma.user.findFirst({
    where: { OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { matricNo: true, staffId: true, email: true },
  });
  if (!hit) return;
  const eq = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const field = eq(hit.matricNo, v.matricNo)
    ? 'matric number'
    : eq(hit.staffId, v.staffId)
      ? 'staff ID'
      : 'email';
  throw Errors.conflict('ALREADY_EXISTS', `A user with that ${field} already exists.`);
}

async function roleRows(db: Tx, keys: readonly string[]) {
  const rows = await db.role.findMany({ where: { key: { in: [...keys] } } });
  if (rows.length !== new Set(keys).size) {
    throw Errors.badRequest('UNKNOWN_ROLE', 'One or more roles do not exist. Run the seed script.');
  }
  return rows;
}

/** Never leave the system without an active administrator. */
async function guardAdmins(tx: Tx, affectedIds: string[]) {
  const losing = await tx.user.count({
    where: {
      id: { in: affectedIds },
      status: 'ACTIVE',
      roles: { some: { role: { key: 'ADMIN' } } },
    },
  });
  if (!losing) return;
  const remaining = await tx.user.count({
    where: {
      id: { notIn: affectedIds },
      status: 'ACTIVE',
      roles: { some: { role: { key: 'ADMIN' } } },
    },
  });
  if (remaining < 1) {
    throw Errors.conflict('LAST_ADMIN', 'At least one active administrator must remain.');
  }
}

const revokeSessions = (tx: Tx, userIds: string[], reason: string) =>
  tx.authSession.updateMany({
    where: { userId: { in: userIds }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

async function hardDelete(tx: Tx, id: string) {
  // Role and permission rows are removed by ON DELETE CASCADE on users. The
  // runtime role cannot delete identity rows directly, which is the point.
  await tx.authSession.deleteMany({ where: { userId: id } });
  await tx.oneTimeToken.deleteMany({ where: { userId: id } });
  await tx.mfaSecret.deleteMany({ where: { userId: id } });
  await tx.studentAccommodation.deleteMany({ where: { studentId: id } });
  await tx.studentProfile.deleteMany({ where: { userId: id } });
  await tx.user.delete({ where: { id } }); // P2003 if exams/audit history
}

/**
 * Resolve initial password for create / import.
 * - Student + no password → surname + last 3 of matric
 * - Staff + no password → error (admin must set it), unless allowGenerateStaff (import fallback)
 * - Explicit password → used as-is (min 8 already validated by schema when present)
 */
function resolvePassword(opts: {
  roles: readonly string[];
  names: string;
  matricNo?: string | null;
  password?: string | null;
  /** Import only: generate random for staff if no password column */
  allowGenerateStaff?: boolean;
}): { password: string; generated: boolean; derivedStudent: boolean } {
  const isStudent = opts.roles.includes('STUDENT');
  const supplied = opts.password?.trim();

  if (supplied) {
    return { password: supplied, generated: false, derivedStudent: false };
  }

  if (isStudent) {
    return {
      password: studentPassword(opts.names, opts.matricNo),
      generated: false,
      derivedStudent: true,
    };
  }

  if (opts.allowGenerateStaff) {
    return { password: tempPassword(), generated: true, derivedStudent: false };
  }

  throw Errors.badRequest(
    'PASSWORD_REQUIRED',
    'Set a password for staff and admin accounts (min 8 characters).',
  );
}

// ---------- list / export ----------
const listQuery = z.object({
  ...pageShape,
  search: optStr(100),
  role: z.preprocess(blankToUndef, z.enum(ROLES).optional()),
  status: z.preprocess(blankToUndef, z.enum(STATUSES).optional()),
  departmentId: optUuid,
});

function whereFrom(q: z.infer<typeof listQuery>): Prisma.UserWhereInput {
  const and: Prisma.UserWhereInput[] = [];
  if (q.search) {
    const c = { contains: q.search, mode: 'insensitive' as const };
    and.push({ OR: [{ names: c }, { matricNo: c }, { staffId: c }, { email: c }] });
  }
  if (q.role) and.push({ roles: { some: { role: { key: q.role } } } });
  if (q.status) and.push({ status: q.status });
  if (q.departmentId) and.push({ departmentId: q.departmentId });
  return and.length ? { AND: and } : {};
}

export const listUsers = async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query);
  const where = whereFrom(q);
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: [{ names: 'asc' }, { id: 'asc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
  ]);
  res.json({ data: rows.map(present), meta: pageMeta(q.page, q.pageSize, total) });
};

export const exportUsers = async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query);
  const rows = await prisma.user.findMany({
    where: whereFrom(q),
    select: userSelect,
    orderBy: [{ names: 'asc' }, { id: 'asc' }],
    take: 20000,
  });
  await prisma.$transaction((tx) =>
    writeAudit(tx, actorFrom(req, res), {
      action: 'user.export',
      targetType: 'User',
      targetId: 'bulk',
      after: { count: rows.length },
    }),
  );
  sendCsv(
    res,
    `LASUSTECH_Users_${new Date().toISOString().slice(0, 10)}.csv`,
    toCsv(
      ['Name', 'Matric No', 'Staff ID', 'Email', 'Roles', 'Department', 'Status', 'Last login'],
      rows.map((u) => [
        u.names,
        u.matricNo,
        u.staffId,
        u.email,
        rolesOf(u).join('; '),
        u.department?.name,
        u.status,
        u.lastLoginAt,
      ]),
    ),
  );
};

// ---------- create ----------
const createSchema = z
  .object({
    names: z.string().trim().min(2).max(120),
    roles: z.array(z.enum(ROLES)).min(1).max(3),
    matricNo: optUpper(40),
    staffId: optUpper(40),
    email: optEmail,
    phone: optStr(30),
    departmentId: optUuid,
    status: z.enum(['ACTIVE', 'INVITED']).default('ACTIVE'),
    /** Optional for students (auto surname+matric). Required for staff/admin. */
    password: z.preprocess(blankToUndef, z.string().min(8).max(100).optional()),
  })
  .superRefine((v, ctx) => {
    const i = identityIssue(v);
    if (i) ctx.addIssue({ code: 'custom', path: [i.field], message: i.message });
  });

export const createUser = async (req: Request, res: Response) => {
  const body = createSchema.parse(req.body);
  await assertUnique(body);

  const { password, generated, derivedStudent } = resolvePassword({
    roles: body.roles,
    names: body.names,
    matricNo: body.matricNo,
    password: body.password,
  });

  // Derived student passwords are a known pattern → hash with USER_ROUNDS; random with TEMP_ROUNDS
  const passwordHash = await bcrypt.hash(
    password,
    generated ? TEMP_ROUNDS : USER_ROUNDS,
  );
  const actor = actorFrom(req, res);

  const user = await prisma.$transaction(async (tx) => {
    await roleRows(tx, body.roles); // friendly error before the DB gatekeeper runs
    const created = await tx.user.create({
      data: {
        names: body.names,
        matricNo: body.matricNo,
        staffId: body.staffId,
        email: body.email,
        phone: body.phone,
        departmentId: body.departmentId,
        passwordHash,
        status: body.status,
      },
      select: { id: true },
    });
    // Roles are written only through the database gatekeeper (see lib/identity).
    await setUserRoles(tx, req.auth!.sessionId, created.id, body.roles, String(res.locals.requestId));
    if (body.roles.includes('STUDENT')) {
      let deptId = body.departmentId;
      if (!deptId) {
        const fallbackDept = await tx.department.findFirst({ where: { active: true }, select: { id: true } });
        deptId = fallbackDept?.id;
        if (deptId) {
          await tx.user.update({ where: { id: created.id }, data: { departmentId: deptId } });
        }
      }
      if (deptId) {
        const prog = await tx.programme.findFirst({ where: { departmentId: deptId, active: true }, select: { id: true } });
        if (prog) {
          const yearMatch = body.matricNo?.match(/\b(20\d{2})\b/);
          const admissionYear = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
          await tx.studentProfile.upsert({
            where: { userId: created.id },
            create: {
              userId: created.id,
              programmeId: prog.id,
              level: 100,
              admissionYear,
            },
            update: {
              programmeId: prog.id,
            },
          });
        }
      }
    }
    const fresh = await tx.user.findUniqueOrThrow({ where: { id: created.id }, select: userSelect });
    await writeAudit(tx, actor, {
      action: 'user.create',
      targetType: 'User',
      targetId: fresh.id,
      after: auditView(fresh),
    });
    return fresh;
  });

  // Always return the password once when it was auto-derived or randomly generated,
  // so the admin can share it. When the admin typed it, they already know it.
  res.status(201).json({
    data: present(user),
    meta:
      generated || derivedStudent
        ? { temporaryPassword: password, passwordSource: derivedStudent ? 'student_pattern' : 'generated' }
        : undefined,
  });
};

// ---------- update ----------
const updateSchema = z.object({
  names: z.string().trim().min(2).max(120).optional(),
  roles: z.array(z.enum(ROLES)).min(1).max(3).optional(),
  matricNo: nullUpper(40),
  staffId: nullUpper(40),
  email: nullEmail,
  phone: nullStr(30),
  departmentId: nullUuid,
  status: z.enum(STATUSES).optional(),
  password: z.preprocess(blankToUndef, z.string().min(8).max(100).optional()),
});

export const updateUser = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const body = updateSchema.parse(req.body);
  const existing = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!existing) throw Errors.notFound('User');

  const currentRoles = rolesOf(existing);
  const nextRoles = body.roles ?? currentRoles;
  const nextStatus = body.status ?? existing.status;
  const isSelf = id === req.auth!.userId;
  if (isSelf && (nextStatus !== 'ACTIVE' || !nextRoles.includes('ADMIN'))) {
    throw Errors.conflict(
      'SELF_LOCKOUT',
      "You can't deactivate your own account or remove your own admin role.",
    );
  }
  // The database gatekeeper refuses this too; catching it here gives the admin
  // an actionable message instead of a raw privilege error.
  const requestedRolesChanged =
    !!body.roles && [...body.roles].sort().join() !== [...currentRoles].sort().join();
  if (isSelf && requestedRolesChanged) {
    throw Errors.conflict(
      'SELF_ROLE_CHANGE',
      "You can't change your own roles. Ask another administrator.",
    );
  }

  const merged = {
    roles: nextRoles,
    matricNo: body.matricNo === undefined ? existing.matricNo : body.matricNo,
    staffId: body.staffId === undefined ? existing.staffId : body.staffId,
    email: body.email === undefined ? existing.email : body.email,
  };
  const issue = identityIssue(merged);
  if (issue) throw new AppError(422, 'VALIDATION_FAILED', issue.message);
  await assertUnique(merged, id);

  const rolesChanged = requestedRolesChanged;
  const leavingActive = existing.status === 'ACTIVE' && nextStatus !== 'ACTIVE';
  const losingAdmin =
    currentRoles.includes('ADMIN') &&
    existing.status === 'ACTIVE' &&
    (leavingActive || !nextRoles.includes('ADMIN'));
  const actor = actorFrom(req, res);

  const updated = await prisma.$transaction(async (tx) => {
    if (losingAdmin) await guardAdmins(tx, [id]);

    const data: Prisma.UserUncheckedUpdateInput = {
      names: body.names,
      matricNo: body.matricNo,
      staffId: body.staffId,
      email: body.email,
      phone: body.phone,
      departmentId: body.departmentId,
      status: body.status,
    };
    if (body.password) {
      data.passwordHash = await bcrypt.hash(body.password, USER_ROUNDS);
      data.failedLoginCount = 0;
      data.lockedUntil = null;
    } else if (nextStatus === 'ACTIVE' && existing.status !== 'ACTIVE') {
      data.failedLoginCount = 0;
      data.lockedUntil = null;
    }
    await tx.user.update({ where: { id }, data });

    if (body.password) {
      await revokeSessions(tx, [id], 'PASSWORD_RESET');
    }

    if (rolesChanged) {
      await roleRows(tx, nextRoles); // friendly error before the DB gatekeeper runs
      await setUserRoles(tx, req.auth!.sessionId, id, nextRoles, String(res.locals.requestId));
      // app_set_roles() already revoked the target's sessions; the call below
      // covers status changes only.
    }
    if (nextRoles.includes('STUDENT') && body.departmentId) {
      const prog = await tx.programme.findFirst({
        where: { departmentId: body.departmentId, active: true },
        select: { id: true },
      });
      if (prog) {
        await tx.studentProfile.upsert({
          where: { userId: id },
          create: {
            userId: id,
            programmeId: prog.id,
            level: 100,
            admissionYear: new Date().getFullYear(),
          },
          update: {
            programmeId: prog.id,
          },
        });
      }
    }
    if (body.status && nextStatus !== 'ACTIVE') {
      await revokeSessions(tx, [id], 'DEACTIVATED');
    }

    const fresh = await tx.user.findUniqueOrThrow({ where: { id }, select: userSelect });
    await writeAudit(tx, actor, {
      action: 'user.update',
      targetType: 'User',
      targetId: id,
      before: auditView(existing),
      after: auditView(fresh),
    });
    return fresh;
  });

  res.json({ data: present(updated) });
};

// ---------- reset password ----------
/** Body: { password?: string }. Omit/blank → random temp. Set → admin-chosen. */
export const resetPassword = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  const { password } = z
    .object({
      password: z.preprocess(blankToUndef, z.string().min(8).max(100).optional()),
    })
    .parse(req.body ?? {});
  const target = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      names: true,
      matricNo: true,
      roles: { select: { scopeType: true, role: { select: { key: true } } } },
    },
  });
  if (!target) throw Errors.notFound('User');

  const generated = !password;
  const next = password ?? tempPassword();
  const passwordHash = await bcrypt.hash(next, generated ? TEMP_ROUNDS : USER_ROUNDS);
  const actor = actorFrom(req, res);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    });
    await revokeSessions(tx, [id], 'PASSWORD_RESET');
    await writeAudit(tx, actor, {
      action: 'user.reset_password',
      targetType: 'User',
      targetId: id,
      after: { names: target.names },
    });
  });

  // When admin set the password they already know it; only return random temps.
  // Optionally include student pattern hint for convenience.
  const isStudent = target.roles.some(
    (r) => r.scopeType === 'GLOBAL' && r.role.key === 'STUDENT',
  );
  res.json({
    data: {
      temporaryPassword: generated ? next : undefined,
      studentPattern:
        !generated && isStudent
          ? undefined
          : isStudent
            ? studentPassword(target.names, target.matricNo)
            : undefined,
    },
  });
};

// ---------- delete ----------
export const deleteUser = async (req: Request, res: Response) => {
  const id = uuidParam(req);
  if (id === req.auth!.userId) {
    throw Errors.conflict('SELF_LOCKOUT', "You can't delete your own account.");
  }
  const existing = await prisma.user.findUnique({ where: { id }, select: userSelect });
  if (!existing) throw Errors.notFound('User');
  const actor = actorFrom(req, res);

  try {
    await prisma.$transaction(async (tx) => {
      await guardAdmins(tx, [id]);
      await hardDelete(tx, id);
      await writeAudit(tx, actor, {
        action: 'user.delete',
        targetType: 'User',
        targetId: id,
        before: auditView(existing),
      });
    });
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2003') {
      throw Errors.conflict(
        'USER_HAS_HISTORY',
        'This user has exam or audit history and cannot be deleted. Deactivate the account instead.',
      );
    }
    throw e;
  }
  res.status(204).end();
};

// ---------- bulk ----------
const bulkSchema = z
  .object({
    action: z.enum(['SET_ROLE', 'ACTIVATE', 'DEACTIVATE', 'RESET_PASSWORD', 'DELETE']),
    ids: z.array(z.uuid()).min(1).max(200),
    role: z.enum(ROLES).optional(),
  })
  .refine((v) => v.action !== 'SET_ROLE' || !!v.role, { message: 'Choose a role.', path: ['role'] })
  .refine((v) => v.action !== 'RESET_PASSWORD' || v.ids.length <= 100, {
    message: 'Reset at most 100 passwords at a time.',
    path: ['ids'],
  });

export const bulkUsers = async (req: Request, res: Response) => {
  const body = bulkSchema.parse(req.body);
  const actor = actorFrom(req, res);
  const selfId = req.auth!.userId;
  const ids = [...new Set(body.ids)];

  const found = new Map(
    (await prisma.user.findMany({ where: { id: { in: ids } }, select: userSelect })).map((u) => [
      u.id,
      u,
    ]),
  );
  const skipped: { id: string; name?: string; reason: string }[] = [];
  const targets: UserRow[] = [];
  for (const id of ids) {
    const u = found.get(id);
    if (!u) skipped.push({ id, reason: 'User not found' });
    else if (id === selfId && !['ACTIVATE', 'RESET_PASSWORD'].includes(body.action)) {
      skipped.push({ id, name: u.names, reason: "You can't do this to your own account" });
    } else targets.push(u);
  }

  let affected = 0;
  let credentials:
    | { id: string; names: string; identifier: string; temporaryPassword: string }[]
    | undefined;

  if (body.action === 'SET_ROLE') {
    const role = body.role!;
    const eligible = targets.filter((u) => {
      const ok = role === 'STUDENT' ? !!u.matricNo : !!(u.staffId || u.email);
      if (!ok) {
        skipped.push({
          id: u.id,
          name: u.names,
          reason: role === 'STUDENT' ? 'No matric number' : 'No staff ID or email',
        });
      }
      return ok;
    });
    if (eligible.length) {
      await prisma.$transaction(async (tx) => {
        const eIds = eligible.map((u) => u.id);
        if (role !== 'ADMIN') await guardAdmins(tx, eIds);
        await roleRows(tx, [role]); // friendly error before the DB gatekeeper runs
        for (const u of eligible) {
          await setUserRoles(tx, req.auth!.sessionId, u.id, [role], String(res.locals.requestId));
          await writeAudit(tx, actor, {
            action: 'user.update',
            targetType: 'User',
            targetId: u.id,
            before: { roles: rolesOf(u) },
            after: { roles: [role] },
          });
        }
      });
    }
    affected = eligible.length;
  }

  if (body.action === 'ACTIVATE' || body.action === 'DEACTIVATE') {
    const activate = body.action === 'ACTIVATE';
    if (targets.length) {
      await prisma.$transaction(async (tx) => {
        const tIds = targets.map((u) => u.id);
        if (!activate) await guardAdmins(tx, tIds);
        await tx.user.updateMany({
          where: { id: { in: tIds } },
          data: activate
            ? { status: 'ACTIVE', failedLoginCount: 0, lockedUntil: null }
            : { status: 'DEACTIVATED' },
        });
        if (!activate) await revokeSessions(tx, tIds, 'DEACTIVATED');
        for (const u of targets) {
          await writeAudit(tx, actor, {
            action: 'user.update',
            targetType: 'User',
            targetId: u.id,
            before: { status: u.status },
            after: { status: activate ? 'ACTIVE' : 'DEACTIVATED' },
          });
        }
      });
    }
    affected = targets.length;
  }

  if (body.action === 'RESET_PASSWORD') {
    // Bulk always generates random temps (no shared password for many accounts).
    // For student pattern re-apply, use single-user reset with an explicit password.
    const hashed: { u: UserRow; pw: string; hash: string }[] = [];
    for (const u of targets) {
      const pw = tempPassword();
      hashed.push({ u, pw, hash: await bcrypt.hash(pw, TEMP_ROUNDS) });
    }
    await prisma.$transaction(async (tx) => {
      for (const { u, hash } of hashed) {
        await tx.user.update({
          where: { id: u.id },
          data: { passwordHash: hash, failedLoginCount: 0, lockedUntil: null },
        });
        await writeAudit(tx, actor, {
          action: 'user.reset_password',
          targetType: 'User',
          targetId: u.id,
          after: { names: u.names },
        });
      }
      await revokeSessions(
        tx,
        targets.map((u) => u.id),
        'PASSWORD_RESET',
      );
    });
    credentials = hashed.map(({ u, pw }) => ({
      id: u.id,
      names: u.names,
      identifier: identifierOf(u),
      temporaryPassword: pw,
    }));
    affected = hashed.length;
  }

  if (body.action === 'DELETE') {
    for (const u of targets) {
      try {
        await prisma.$transaction(async (tx) => {
          await guardAdmins(tx, [u.id]);
          await hardDelete(tx, u.id);
          await writeAudit(tx, actor, {
            action: 'user.delete',
            targetType: 'User',
            targetId: u.id,
            before: auditView(u),
          });
        });
        affected++;
      } catch (e) {
        const code = (e as { code?: string })?.code;
        skipped.push({
          id: u.id,
          name: u.names,
          reason:
            code === 'P2003'
              ? 'Has exam or audit history: deactivate instead'
              : e instanceof AppError
                ? e.message
                : 'Could not delete',
        });
      }
    }
  }

  res.json({
    data: { action: body.action, affected, skipped },
    meta: credentials ? { credentials } : undefined,
  });
};

// ---------- CSV import (rows are parsed in the browser) ----------
const importBody = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
  dryRun: z.boolean().default(false),
});

const importRow = z.object({
  names: z.string().trim().min(2).max(120),
  role: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase().replace(/[\s-]+/g, '_'))
    .transform((s) => (s === 'ADMINISTRATOR' ? 'ADMIN' : s))
    .pipe(z.enum(ROLES)),
  matricNo: optUpper(40),
  staffId: optUpper(40),
  email: optEmail,
  department: optStr(120),
  /** Optional. Students ignore this and use surname+matric unless you want to override. */
  password: z.preprocess(blankToUndef, z.string().min(8).max(100).optional()),
});

export const importUsers = async (req: Request, res: Response) => {
  const body = importBody.parse(req.body);
  const depts = await prisma.department.findMany({
    select: { id: true, code: true, name: true },
  });
  const deptFor = (s?: string) =>
    s
      ? depts.find(
          (d) =>
            d.code.toLowerCase() === s.toLowerCase() || d.name.toLowerCase() === s.toLowerCase(),
        )
      : undefined;

  const failed: { row: number; reason: string }[] = [];
  const valid: { row: number; v: z.infer<typeof importRow>; departmentId?: string }[] = [];
  const seen = {
    matric: new Set<string>(),
    staff: new Set<string>(),
    email: new Set<string>(),
  };

  body.rows.forEach((raw, i) => {
    const row = i + 2; // spreadsheet line (header is line 1)
    const p = importRow.safeParse(raw);
    if (!p.success) {
      const is = p.error.issues[0];
      return void failed.push({
        row,
        reason: `${is.path.join('.') || 'row'}: ${is.message}`,
      });
    }
    const v = p.data;
    const issue = identityIssue({
      roles: [v.role],
      matricNo: v.matricNo,
      staffId: v.staffId,
      email: v.email,
    });
    if (issue) return void failed.push({ row, reason: issue.message });
    const dept = deptFor(v.department);
    if (v.department && !dept) {
      return void failed.push({ row, reason: `Unknown department "${v.department}"` });
    }
    for (const [set, val, label] of [
      [seen.matric, v.matricNo, 'matric number'],
      [seen.staff, v.staffId, 'staff ID'],
      [seen.email, v.email, 'email'],
    ] as const) {
      if (val && set.has(val)) {
        return void failed.push({ row, reason: `Duplicate ${label} in this file` });
      }
    }
    if (v.matricNo) seen.matric.add(v.matricNo);
    if (v.staffId) seen.staff.add(v.staffId);
    if (v.email) seen.email.add(v.email);
    valid.push({ row, v, departmentId: dept?.id });
  });

  // duplicates against existing users
  const m = [...seen.matric];
  const s = [...seen.staff];
  const e = [...seen.email];
  const existing = valid.length
    ? await prisma.user.findMany({
        where: {
          OR: [
            ...(m.length ? [{ matricNo: { in: m } }] : []),
            ...(s.length ? [{ staffId: { in: s } }] : []),
            ...(e.length ? [{ email: { in: e } }] : []),
          ],
        },
        select: { matricNo: true, staffId: true, email: true },
      })
    : [];
  const taken = new Set(
    existing.flatMap((u) => [u.matricNo, u.staffId, u.email].filter(Boolean) as string[]),
  );
  const ready = valid.filter((r) => {
    const clash = [r.v.matricNo, r.v.staffId, r.v.email].find((x) => x && taken.has(x));
    if (clash) failed.push({ row: r.row, reason: `${clash} already exists` });
    return !clash;
  });

  if (body.dryRun) {
    return void res.json({
      data: {
        total: body.rows.length,
        valid: ready.length,
        failed: failed.sort((a, b) => a.row - b.row),
      },
    });
  }

  const credentials: {
    id: string;
    names: string;
    identifier: string;
    temporaryPassword: string;
  }[] = [];

  for (const r of ready) {
    try {
      const { password: pw, generated } = resolvePassword({
        roles: [r.v.role],
        names: r.v.names,
        matricNo: r.v.matricNo,
        password: r.v.password,
        // Staff rows without a Password column get a random temp (import convenience)
        allowGenerateStaff: true,
      });

      const created = await prisma.$transaction(async (tx) => {
        const u = await tx.user.create({
          data: {
            names: r.v.names,
            matricNo: r.v.matricNo,
            staffId: r.v.staffId,
            email: r.v.email,
            departmentId: r.departmentId,
            status: 'ACTIVE',
            passwordHash: await bcrypt.hash(pw, generated ? TEMP_ROUNDS : USER_ROUNDS),
          },
          select: {
            id: true,
            names: true,
            matricNo: true,
            staffId: true,
            email: true,
          },
        });
        // Roles go through the DB gatekeeper, exactly as single-user creation does.
        await setUserRoles(
          tx,
          req.auth!.sessionId,
          u.id,
          [r.v.role as RoleKey],
          String(res.locals.requestId),
        );
        if (r.v.role === 'STUDENT') {
          let deptId = r.departmentId;
          if (!deptId && r.v.matricNo) {
            const prefix = r.v.matricNo.split(/[\/-]/)[0]?.toUpperCase();
            if (prefix) {
              const matchedDept = await tx.department.findFirst({
                where: { code: { equals: prefix, mode: 'insensitive' }, active: true },
                select: { id: true },
              });
              if (matchedDept) {
                deptId = matchedDept.id;
                await tx.user.update({ where: { id: u.id }, data: { departmentId: deptId } });
              }
            }
          }
          if (!deptId) {
            const fallbackDept = await tx.department.findFirst({ where: { active: true }, select: { id: true } });
            deptId = fallbackDept?.id;
            if (deptId) {
              await tx.user.update({ where: { id: u.id }, data: { departmentId: deptId } });
            }
          }
          if (deptId) {
            const prog = await tx.programme.findFirst({
              where: { departmentId: deptId, active: true },
              select: { id: true },
            });
            if (prog) {
              const yearMatch = r.v.matricNo?.match(/\b(20\d{2})\b/);
              const admissionYear = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();
              await tx.studentProfile.upsert({
                where: { userId: u.id },
                create: {
                  userId: u.id,
                  programmeId: prog.id,
                  level: 100,
                  admissionYear,
                },
                update: {
                  programmeId: prog.id,
                },
              });
            }
          }
        }
        return u;
      });
      credentials.push({
        id: created.id,
        names: created.names,
        identifier: identifierOf(created),
        temporaryPassword: pw,
      });
    } catch (err) {
      failed.push({
        row: r.row,
        reason:
          (err as { code?: string })?.code === 'P2002'
            ? 'Already exists'
            : err instanceof AppError
              ? err.message
              : 'Could not be created',
      });
    }
  }

  await prisma.$transaction((tx) =>
    writeAudit(tx, actorFrom(req, res), {
      action: 'user.import',
      targetType: 'User',
      targetId: 'bulk',
      after: {
        created: credentials.length,
        failed: failed.length,
        ids: credentials.map((c) => c.id),
      },
    }),
  );

  res.status(201).json({
    data: {
      total: body.rows.length,
      created: credentials.length,
      failed: failed.sort((a, b) => a.row - b.row),
    },
    meta: { credentials },
  });
};

const setUserCoursesSchema = z.object({
  courseIds: z.array(z.string().uuid()),
  sessionId: z.string().uuid().optional(),
});

export const getUserCourses = async (req: Request, res: Response) => {
  const userId = uuidParam(req);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      names: true,
      staffId: true,
      matricNo: true,
      email: true,
      roles: { select: { role: { select: { key: true } } } },
    },
  });
  if (!user) throw Errors.notFound('User');

  // Resolve current or active academic session with graceful fallback
  let session = await prisma.academicSession.findFirst({
    where: { isCurrent: true },
    select: { id: true, name: true, isCurrent: true },
  });
  if (!session) {
    session = await prisma.academicSession.findFirst({
      where: { closedAt: null },
      orderBy: { startsOn: 'desc' },
      select: { id: true, name: true, isCurrent: true },
    }) || await prisma.academicSession.findFirst({
      orderBy: { startsOn: 'desc' },
      select: { id: true, name: true, isCurrent: true },
    });
  }

  const isStudent = user.roles.some((r) => r.role.key === 'STUDENT');

  if (isStudent) {
    const enrollments = await prisma.enrollment.findMany({
      where: {
        studentId: userId,
        ...(session ? { sessionId: session.id } : {}),
      },
      include: {
        course: {
          select: {
            id: true,
            code: true,
            title: true,
            level: true,
            units: true,
            active: true,
            department: {
              select: { id: true, name: true, code: true },
            },
          },
        },
        session: {
          select: { id: true, name: true, isCurrent: true },
        },
      },
      orderBy: { course: { code: 'asc' } },
    });

    return res.json({
      data: {
        user,
        session,
        isStudent: true,
        assignments: enrollments.map((e) => ({
          courseId: e.courseId,
          course: e.course,
          role: 'STUDENT',
          sessionId: e.sessionId,
          session: e.session,
        })),
        courseIds: enrollments.map((e) => e.courseId),
      },
    });
  }

  const assignments = await prisma.courseAssignment.findMany({
    where: {
      userId,
      ...(session ? { sessionId: session.id } : {}),
      role: 'LECTURER',
    },
    include: {
      course: {
        select: {
          id: true,
          code: true,
          title: true,
          level: true,
          units: true,
          active: true,
          department: {
            select: { id: true, name: true, code: true },
          },
        },
      },
      session: {
        select: { id: true, name: true, isCurrent: true },
      },
    },
    orderBy: { course: { code: 'asc' } },
  });

  res.json({
    data: {
      user,
      session,
      isStudent: false,
      assignments: assignments.map((a) => ({
        courseId: a.courseId,
        course: a.course,
        role: a.role,
        sessionId: a.sessionId,
        session: a.session,
      })),
      courseIds: assignments.map((a) => a.courseId),
    },
  });
};

export const setUserCourses = async (req: Request, res: Response) => {
  const userId = uuidParam(req);
  const body = setUserCoursesSchema.parse(req.body);
  const actor = actorFrom(req, res);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { select: { role: { select: { key: true } } } } },
  });
  if (!user) throw Errors.notFound('User');

  const isStudent = user.roles.some((r) => r.role.key === 'STUDENT');
  const isStaff = user.roles.some((r) => r.role.key === 'LECTURER' || r.role.key === 'ADMIN');
  if (!isStaff && !isStudent) {
    throw Errors.badRequest('INVALID_ROLE', 'User must hold STUDENT, LECTURER, or ADMIN role to have courses assigned.');
  }

  let session = body.sessionId
    ? await prisma.academicSession.findUnique({ where: { id: body.sessionId }, select: { id: true, name: true } })
    : await prisma.academicSession.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });

  if (!session) {
    session = await prisma.academicSession.findFirst({
      where: { closedAt: null },
      orderBy: { startsOn: 'desc' },
      select: { id: true, name: true },
    }) || await prisma.academicSession.findFirst({
      orderBy: { startsOn: 'desc' },
      select: { id: true, name: true },
    });
  }

  if (!session) {
    throw Errors.conflict('NO_SESSION', 'Please create an academic session before assigning courses.');
  }

  const courseIds = [...new Set(body.courseIds)];
  if (courseIds.length > 0) {
    const validCount = await prisma.course.count({
      where: { id: { in: courseIds } },
    });
    if (validCount !== courseIds.length) {
      throw Errors.badRequest('INVALID_COURSE', 'One or more selected courses do not exist.');
    }
  }

  const finalSession = session;
  await prisma.$transaction(async (tx) => {
    if (isStudent) {
      // Clear previous student course enrollments for this session
      await tx.enrollment.deleteMany({
        where: {
          studentId: userId,
          sessionId: finalSession.id,
        },
      });

      if (courseIds.length > 0) {
        // Create new active student enrollments
        await tx.enrollment.createMany({
          data: courseIds.map((courseId) => ({
            courseId,
            studentId: userId,
            sessionId: finalSession.id,
            status: 'ACTIVE' as const,
          })),
          skipDuplicates: true,
        });

        // Automatically register candidate into any active (SCHEDULED or OPEN) sittings for these courses!
        const activeSittings = await tx.sitting.findMany({
          where: {
            status: { in: ['SCHEDULED', 'OPEN'] },
            exam: {
              courseId: { in: courseIds },
              ...(finalSession ? { sessionId: finalSession.id } : {}),
            },
          },
          select: { id: true },
        });

        if (activeSittings.length > 0) {
          await tx.sittingStudent.createMany({
            data: activeSittings.map((s) => ({
              sittingId: s.id,
              studentId: userId,
            })),
            skipDuplicates: true,
          });
        }
      }

      await writeAudit(tx, actor, {
        action: 'user.enroll_courses',
        targetType: 'User',
        targetId: userId,
        after: { courseIds, sessionId: finalSession.id, isStudent: true },
      });
    } else {
      // Staff / Lecturer assignment
      await tx.courseAssignment.deleteMany({
        where: {
          userId,
          sessionId: finalSession.id,
          role: 'LECTURER',
        },
      });

      if (courseIds.length > 0) {
        await tx.courseAssignment.createMany({
          data: courseIds.map((courseId) => ({
            courseId,
            userId,
            sessionId: finalSession.id,
            role: 'LECTURER' as const,
          })),
          skipDuplicates: true,
        });
      }

      await writeAudit(tx, actor, {
        action: 'user.assign_courses',
        targetType: 'User',
        targetId: userId,
        after: { courseIds, sessionId: finalSession.id, isStudent: false },
      });
    }
  });

  res.json({
    data: {
      userId,
      courseIds,
      assignedCount: courseIds.length,
      sessionId: finalSession.id,
      isStudent,
    },
  });
};