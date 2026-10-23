/**
 * Database verification harness for LASUSTECH CBT.
 *
 * Run after `prisma migrate deploy && prisma db seed`:
 *
 *   pnpm --filter @lasustech-cbt/db verify
 *
 * It checks four things:
 *   1. the migration produced every table/column/type the schema expects;
 *   2. the hand-written integrity layer exists (partial unique indexes,
 *      check constraints, append-only audit trigger, trigram search indexes);
 *   3. the seed produced a coherent institution;
 *   4. the constraints actually reject bad data — each probe runs in its own
 *      transaction and is rolled back, so the database is left untouched.
 *
 * Exit code 0 = every check passed. 1 = at least one failed.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];

const pass = (name: string, detail?: string) => results.push({ name, ok: true, detail });
const fail = (name: string, detail: string) => results.push({ name, ok: false, detail });

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

// ---------------------------------------------------------------------------
// 1. Schema: tables, enums, column types
// ---------------------------------------------------------------------------

const EXPECTED_TABLES = [
  'academic_sessions', 'answer_events', 'answers', 'appeals', 'attempt_events',
  'attempt_questions', 'attempts', 'audit_logs', 'auth_sessions', 'colleges',
  'course_assignments', 'courses', 'departments', 'enrollments', 'exam_questions',
  'exam_rules', 'exam_sections', 'exams', 'export_jobs', 'feature_flags', 'flags',
  'grade_bands', 'idempotency_keys', 'import_jobs', 'incidents', 'interventions', 'media_assets',
  'mfa_secrets', 'moderation_reviews', 'notifications', 'one_time_tokens',
  'options', 'outbox_events', 'pairs', 'paper_bundles', 'password_history',
  'portal_pushes', 'proctor_snapshots', 'programme_courses', 'programmes',
  'question_versions', 'questions', 'result_batches', 'results', 'role_change_log',
  'role_permissions',
  'roles', 'score_changes', 'semesters', 'settings', 'sitting_invigilators',
  'sitting_students', 'sittings', 'student_accommodations', 'student_profiles',
  'topics', 'user_permissions', 'user_roles', 'users', 'venues', 'version_tags',
];

const EXPECTED_ENUMS: Record<string, string[]> = {
  AnswerFormat: ['MCQ_SINGLE', 'MCQ_MULTI', 'MATCHING'],
  AttemptEndedReason: ['STUDENT_SUBMIT', 'AUTO_SUBMIT', 'EXPIRED', 'TERMINATED', 'INVIGILATOR_END'],
  AttemptStatus: ['NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED', 'EXPIRED'],
  ClockPolicy: ['RUNNING', 'PAUSE_ON_DISCONNECT'],
  ExamKind: ['MID_SEMESTER', 'END_OF_SEMESTER', 'MOCK', 'QUIZ', 'RESIT', 'SUPPLEMENTARY'],
  ExamStatus: ['DRAFT', 'IN_MODERATION', 'APPROVED', 'LOCKED', 'ARCHIVED'],
  Grade: ['A', 'B', 'C', 'D', 'E', 'F'],
  IncidentCategory: ['MALPRACTICE', 'TECHNICAL', 'INFRASTRUCTURE', 'MEDICAL', 'CONDUCT'],
  IncidentSeverity: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
  IncidentStatus: ['UNDER_REVIEW', 'ESCALATED', 'RESOLVED'],
  JobStatus: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'],
  ScopeType: ['GLOBAL', 'COLLEGE', 'DEPARTMENT', 'COURSE'],
  SittingStatus: ['SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED'],
  UserStatus: ['INVITED', 'ACTIVE', 'LOCKED', 'DEACTIVATED'],
};

async function checkSchema() {
  section('Schema');

  const tables = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  const have = new Set(tables.map((t) => t.table_name));

  const missing = EXPECTED_TABLES.filter((t) => !have.has(t));
  missing.length ? fail('all expected tables exist', `missing: ${missing.join(', ')}`)
                 : pass('all expected tables exist', `${EXPECTED_TABLES.length} tables`);

  for (const [name, values] of Object.entries(EXPECTED_ENUMS)) {
    const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = ${name} ORDER BY e.enumsortorder`;
    const got = rows.map((r) => r.enumlabel);
    const wrong = values.filter((v) => !got.includes(v));
    wrong.length ? fail(`enum ${name}`, `missing: ${wrong.join(', ')}; got: ${got.join(', ') || '(none)'}`)
                 : pass(`enum ${name}`, got.join(', '));
  }

  // The migration must have created citext, not plain text, or every
  // case-insensitive lookup degrades to a sequential scan.
  const citext = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'USER-DEFINED'
      AND udt_name = 'citext'
      AND table_name IN ('users')`;
  const citextCols = new Set(citext.map((c) => c.column_name));
  ['matric_no', 'staff_id', 'email'].every((c) => citextCols.has(c))
    ? pass('users identity columns use citext')
    : fail('users identity columns use citext', `found: ${[...citextCols].join(', ') || '(none)'}`);

  const precision = await prisma.$queryRaw<{ datetime_precision: number }[]>`
    SELECT datetime_precision FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_logs' AND column_name = 'at'`;
  Number(precision[0]?.datetime_precision) === 3
    ? pass('audit_logs.at keeps millisecond precision')
    : fail('audit_logs.at keeps millisecond precision', `precision=${precision[0]?.datetime_precision}`);

  const applied = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
  Number(applied[0]?.count) >= 1
    ? pass('migration applied', `${applied[0]?.count} migration(s)`)
    : fail('migration applied', 'no finished migrations');
}

// ---------------------------------------------------------------------------
// 2. Integrity layer
// ---------------------------------------------------------------------------

async function checkIndexes() {
  section('Integrity layer');

  const extensions = await prisma.$queryRaw<{ extname: string }[]>`
    SELECT extname FROM pg_extension WHERE extname IN ('citext', 'pg_trgm')`;
  const ext = new Set(extensions.map((e) => e.extname));
  ['citext', 'pg_trgm'].every((e) => ext.has(e))
    ? pass('required extensions installed')
    : fail('required extensions installed', `missing: ${['citext', 'pg_trgm'].filter((e) => !ext.has(e)).join(', ')}`);

  const wanted = [
    { name: 'academic_sessions_one_current_key', table: 'academic_sessions', predicate: 'is_current' },
    { name: 'results_one_current_per_attempt_key', table: 'results', predicate: 'is_current' },
    { name: 'user_roles_global_key', table: 'user_roles', predicate: 'scope_id IS NULL' },
    { name: 'user_roles_scoped_key', table: 'user_roles', predicate: 'scope_id IS NOT NULL' },
    { name: 'user_permissions_global_key', table: 'user_permissions', predicate: 'scope_id IS NULL' },
  ];

  const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`;
  const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));

  for (const w of wanted) {
    const def = byName.get(w.name);
    if (!def) { fail(`partial unique index ${w.name}`, 'missing'); continue; }
    def.includes(w.table) && /UNIQUE/i.test(def) && def.includes('WHERE') && def.includes(w.predicate)
      ? pass(`partial unique index ${w.name}`)
      : fail(`partial unique index ${w.name}`, def);
  }

  for (const [name, table] of [
    ['users_names_trgm_idx', 'users'],
    ['courses_code_trgm_idx', 'courses'],
    ['courses_title_trgm_idx', 'courses'],
  ]) {
    const def = byName.get(name);
    def && def.includes('gin') && def.includes(table)
      ? pass(`trigram index ${name}`)
      : fail(`trigram index ${name}`, def ?? 'missing');
  }

  const constraints = await prisma.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`;
  const names = new Set(constraints.map((c) => c.conname));
  for (const c of [
    'academic_sessions_dates_check', 'semesters_dates_check', 'sittings_window_check',
    'grade_bands_range_check', 'results_score_check', 'question_versions_marks_check',
    'exam_rules_count_marks_check', 'exam_sections_weight_check', 'user_roles_scope_check',
    'user_permissions_scope_check', 'media_assets_bytes_check',
  ]) {
    names.has(c) ? pass(`check constraint ${c}`) : fail(`check constraint ${c}`, 'missing');
  }

  const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = 'audit_logs'::regclass`;
  triggers.some((t) => t.tgname === 'audit_logs_immutable')
    ? pass('audit_logs append-only trigger')
    : fail('audit_logs append-only trigger', 'missing');
  triggers.some((t) => t.tgname === 'audit_logs_immutable_truncate')
    ? pass('audit_logs TRUNCATE guard')
    : fail('audit_logs TRUNCATE guard', 'missing');

  const fns = await prisma.$queryRaw<{ proname: string }[]>`
    SELECT proname FROM pg_proc WHERE proname IN ('audit_logs_reject_mutation', 'audit_logs_reject_truncate')`;
  fns.length === 2
    ? pass('audit guard functions defined')
    : fail('audit guard functions defined', `found ${fns.length}/2`);

  const identityTriggers = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgrelid IN ('user_roles'::regclass, 'user_permissions'::regclass,
                       'roles'::regclass, 'role_permissions'::regclass)`;
  const guardNames = new Set(identityTriggers.map((t) => t.tgname));
  for (const t of ['user_roles_guarded', 'user_permissions_guarded', 'roles_guarded', 'role_permissions_guarded']) {
    guardNames.has(t) ? pass(`identity guard ${t}`) : fail(`identity guard ${t}`, 'missing');
  }

  const logTriggers = await prisma.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger
     WHERE NOT tgisinternal AND tgrelid = 'role_change_log'::regclass`;
  logTriggers.length >= 2
    ? pass('role_change_log append-only triggers')
    : fail('role_change_log append-only triggers', `found ${logTriggers.length}/2`);

  const applied = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
  Number(applied[0]?.count) >= 4
    ? pass('migration chain applied', `${applied[0]?.count} migration(s)`)
    : fail('migration chain applied', `only ${applied[0]?.count} applied — 3_incidents has not run`);
}

// ---------------------------------------------------------------------------
// 3. Seed coherence
// ---------------------------------------------------------------------------

async function checkSeed() {
  section('Seed');

  const [colleges, departments, programmes, courses, users, roles, bands, sessions, semesters, sessionsCurrent] =
    await Promise.all([
      prisma.college.count(), prisma.department.count(), prisma.programme.count(),
      prisma.course.count(), prisma.user.count(), prisma.role.count(),
      prisma.gradeBand.count(), prisma.academicSession.count(), prisma.semester.count(),
      prisma.academicSession.count({ where: { isCurrent: true } }),
    ]);

  const expected: [string, number, number][] = [
    ['colleges', colleges, 5], ['departments', departments, 38],
    ['programmes', programmes, 39], ['courses', courses, 48],
    ['users', users, 3], ['roles', roles, 3], ['grade bands', bands, 6],
    ['academic sessions', sessions, 2], ['semesters', semesters, 4],
  ];
  for (const [label, got, want] of expected) {
    got === want ? pass(`${label} seeded`, String(got))
                 : fail(`${label} seeded`, `expected ${want}, got ${got}`);
  }
  sessionsCurrent === 1
    ? pass('exactly one current session')
    : fail('exactly one current session', `got ${sessionsCurrent}`);

  const roleKeys = await prisma.role.findMany({ select: { key: true }, orderBy: { key: 'asc' } });
  const keyList = roleKeys.map((r) => r.key);
  keyList.join(',') === 'ADMIN,LECTURER,STUDENT'
    ? pass('exactly the three institution roles', keyList.join(', '))
    : fail('exactly the three institution roles', `got ${keyList.join(', ') || '(none)'}`);

  const usersWithoutRole = await prisma.user.count({ where: { roles: { none: {} } } });
  usersWithoutRole === 0
    ? pass('every user has a role')
    : fail('every user has a role', `${usersWithoutRole} without a role`);

  const current = await prisma.academicSession.findFirst({ where: { isCurrent: true } });
  if (current) {
    const outside = await prisma.semester.count({
      where: {
        sessionId: current.id,
        OR: [{ startsOn: { lt: current.startsOn } }, { endsOn: { gt: current.endsOn } }],
      },
    });
    outside === 0
      ? pass('current session semesters sit inside the session')
      : fail('current session semesters sit inside the session', `${outside} outside`);
  }

  const orphanEnrollments = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM enrollments e
    WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.student_id)`;
  Number(orphanEnrollments[0]?.count) === 0
    ? pass('no orphan enrollments')
    : fail('no orphan enrollments', String(orphanEnrollments[0]?.count));

  const assignmentsWrongSession = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM course_assignments
    WHERE NOT EXISTS (SELECT 1 FROM academic_sessions s WHERE s.id = session_id)`;
  Number(assignmentsWrongSession[0]?.count) === 0
    ? pass('course assignments reference real sessions')
    : fail('course assignments reference real sessions', String(assignmentsWrongSession[0]?.count));
}

// ---------------------------------------------------------------------------
// 4. Constraint probes (rolled back)
// ---------------------------------------------------------------------------

class Rollback extends Error {}

/**
 * Runs `fn` in a transaction that is always rolled back. If `fn` completes
 * without throwing, the constraint it was probing did not fire → failure.
 */
async function expectReject(name: string, fn: (tx: any) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback('probe completed without a constraint error');
    });
    fail(name, 'bad data was accepted');
  } catch (e) {
    if (e instanceof Rollback) fail(name, e.message);
    else pass(name, (e as { code?: string }).code ?? (e as Error).message.split('\n')[0]);
  }
}

/** The mirror image: the operation must succeed. Still rolled back. */
async function expectAllow(name: string, fn: (tx: any) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new Rollback('rolled back');
    });
  } catch (e) {
    if (e instanceof Rollback) pass(name);
    else fail(name, (e as Error).message.split('\n')[0] ?? String(e));
  }
}

/** A live auth session for a user, created inside a rolled-back probe. */
async function makeSession(tx: any, userId: string): Promise<string> {
  const rows = await tx.$queryRaw`
    INSERT INTO auth_sessions
      (id, user_id, family_id, refresh_token_hash, device_hash, ip, user_agent, last_seen_at, expires_at)
    VALUES
      (gen_random_uuid(), ${userId}::uuid, gen_random_uuid()::text, 'verify', 'verify',
       '127.0.0.1', 'verify-db', now(), now() + interval '1 hour')
    RETURNING id`;
  return rows[0].id as string;
}

async function checkConstraints() {
  section('Constraint probes');

  const student = await prisma.user.findFirst({ where: { matricNo: { not: null } } });
  const admin = await prisma.user.findFirst({ where: { roles: { some: { role: { key: 'ADMIN' } } } } });
  const course = await prisma.course.findFirst();
  const session = await prisma.academicSession.findFirst({ where: { isCurrent: true } });
  const adminRole = await prisma.role.findUnique({ where: { key: 'ADMIN' } });

  if (!student || !admin || !course || !session || !adminRole) {
    fail('constraint probes', 'seed data missing (run `prisma db seed` first)');
    return;
  }

  // case-insensitive uniqueness (citext)
  await expectReject('citext rejects a different-case duplicate email', async (tx) => {
    await tx.user.create({
      data: { names: 'Verify Duplicate', email: admin.email!.toUpperCase(), status: 'ACTIVE' },
    });
  });

  // duplicate global role
  await expectReject('duplicate GLOBAL role is rejected', async (tx) => {
    await tx.userRole.create({
      data: { userId: admin.id, roleId: adminRole.id, scopeType: 'GLOBAL' },
    });
  });

  // scoped role without a scope id
  await expectReject('scoped role without scope_id is rejected', async (tx) => {
    await tx.userRole.create({
      data: { userId: student.id, roleId: adminRole.id, scopeType: 'COLLEGE' },
    });
  });

  // a second current academic session
  await expectReject('second current academic session is rejected', async (tx) => {
    await tx.academicSession.create({
      data: {
        name: '2099/2100',
        startsOn: new Date('2099-01-01'), endsOn: new Date('2099-12-31'),
        isCurrent: true,
      },
    });
  });

  // a second current result for one attempt
  const exam = await prisma.exam.findFirst();
  const sitting = exam ? await prisma.sitting.findFirst({ where: { examId: exam.id } }) : null;
  const existingAttempt = sitting
    ? await prisma.attempt.findFirst({ where: { sittingId: sitting.id } })
    : null;

  if (sitting && existingAttempt) {
    await expectReject('second current result per attempt is rejected', async (tx) => {
      await tx.result.create({
        data: {
          attemptId: existingAttempt.id,
          scoreVersion: 999,
          rawScore: 60, maxScore: 100, percent: 60,
          grade: 'B', status: 'SCORED', isCurrent: true,
        },
      });
    });
  } else {
    // No exam fixture in the seed: build the smallest possible chain.
    await expectReject('second current result per attempt is rejected', async (tx) => {
      const e = await tx.exam.create({
        data: {
          courseId: course.id, sessionId: session.id, title: 'Verify exam',
          kind: 'MOCK', settings: {},
        },
      });
      const st = await tx.sitting.create({
        data: {
          examId: e.id,
          startsAt: new Date('2099-01-01T09:00:00Z'),
          endsAt: new Date('2099-01-01T11:00:00Z'),
          durationMin: 120, timerMode: 'PER_STUDENT_START',
          lateGraceMin: 0, lateCutoffMin: 0, clockPolicy: 'RUNNING',
          maxPauseMin: 0, reconnectGraceSec: 30, venue: 'VERIFY',
          deliveryMode: 'LAB', requireWebcam: false, requireSeb: false,
          accessCodeHash: 'x',
        },
      });
      const at = await tx.attempt.create({
        data: { sittingId: st.id, studentId: student.id, questionCount: 1, totalMarks: 100 },
      });
      await tx.result.create({
        data: {
          attemptId: at.id, scoreVersion: 1, rawScore: 60, maxScore: 100,
          percent: 60, grade: 'B', status: 'SCORED', isCurrent: true,
        },
      });
      await tx.result.create({
        data: {
          attemptId: at.id, scoreVersion: 2, rawScore: 70, maxScore: 100,
          percent: 70, grade: 'A', status: 'SCORED', isCurrent: true,
        },
      });
    });
  }

  // percentage outside 0..100
  await expectReject('result percentage above 100 is rejected', async (tx) => {
    const e = await tx.exam.create({
      data: { courseId: course.id, sessionId: session.id, title: 'Verify check', kind: 'MOCK', settings: {} },
    });
    const st = await tx.sitting.create({
      data: {
        examId: e.id, startsAt: new Date('2099-01-01T09:00:00Z'),
        endsAt: new Date('2099-01-01T11:00:00Z'), durationMin: 120,
        timerMode: 'FIXED_END', lateGraceMin: 0, lateCutoffMin: 0,
        clockPolicy: 'RUNNING', maxPauseMin: 0, reconnectGraceSec: 30,
        venue: 'VERIFY', deliveryMode: 'LAB', requireWebcam: false,
        requireSeb: false, accessCodeHash: 'x',
      },
    });
    const at = await tx.attempt.create({
      data: { sittingId: st.id, studentId: student.id, questionCount: 1, totalMarks: 100 },
    });
    await tx.result.create({
      data: {
        attemptId: at.id, scoreVersion: 1, rawScore: 150, maxScore: 100,
        percent: 150, grade: 'A', status: 'SCORED', isCurrent: true,
      },
    });
  });

  // foreign key
  await expectReject('enrollment with unknown student is rejected', async (tx) => {
    await tx.enrollment.create({
      data: {
        studentId: '00000000-0000-0000-0000-000000000000',
        courseId: course.id, sessionId: session.id, status: 'ACTIVE',
      },
    });
  });

  // append-only audit — the row is created inside the probe so this runs even
  // on a freshly seeded database, where no audit entries exist yet.
  const auditProbe = (tx: any) =>
    tx.auditLog.create({
      data: {
        actorId: admin.id, actorRole: 'ADMIN', action: 'verify.probe',
        targetType: 'verify', targetId: 'probe', ip: '127.0.0.1',
        userAgent: 'verify-db', requestId: 'verify-db',
        prevHash: 'GENESIS', hash: 'probe',
      },
    });

  await expectReject('audit_logs rejects UPDATE', async (tx) => {
    const row = await auditProbe(tx);
    await tx.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } });
  });
  await expectReject('audit_logs rejects DELETE', async (tx) => {
    const row = await auditProbe(tx);
    await tx.auditLog.delete({ where: { id: row.id } });
  });
  await expectReject('audit_logs rejects TRUNCATE', async (tx) => {
    await tx.$executeRawUnsafe('TRUNCATE TABLE "audit_logs"');
  });
}

// ---------------------------------------------------------------------------
// 5. Identity hardening (least privilege + the role gatekeeper)
// ---------------------------------------------------------------------------

async function checkIdentitySecurity() {
  section('Identity hardening');

  const roles = await prisma.$queryRaw<
    { rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }[]
  >`
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
      FROM pg_roles WHERE rolname = 'cbt_app'`;
  const app = roles[0];

  if (!app) {
    fail('runtime role cbt_app exists', 'missing — run 2_identity_hardening');
    return;
  }
  pass('runtime role cbt_app exists');
  !app.rolsuper && !app.rolcreatedb && !app.rolcreaterole && !app.rolbypassrls
    ? pass('cbt_app is not superuser, createdb, createrole or bypassrls')
    : fail(
        'cbt_app is not superuser, createdb, createrole or bypassrls',
        JSON.stringify(app),
      );

  // A behaviour probe, not pg_has_role(): this harness connects as the owner
  // superuser. SET ROLE is checked against the *session* user, which would
  // still be that superuser, so `SET ROLE owner` after `SET ROLE cbt_app`
  // succeeds for the wrong reason. SET SESSION AUTHORIZATION replaces the
  // session user as well, so the following SET ROLE is evaluated as cbt_app —
  // exactly what someone holding the runtime credentials would try.
  const ownerRows = await prisma.$queryRaw<{ owner: string }[]>`SELECT current_user AS owner`;
  const ownerName = ownerRows[0]?.owner ?? '';
  await expectReject('cbt_app cannot assume the owner role', async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL SESSION AUTHORIZATION cbt_app');
    await tx.$executeRawUnsafe(`SET LOCAL ROLE "${ownerName.replace(/"/g, '""')}"`);
  });

  const [priv] = await prisma.$queryRaw<
    {
      schema_usage: boolean;
      schema_create: boolean;
      ur_select: boolean;
      ur_insert: boolean;
      ur_update: boolean;
      ur_delete: boolean;
      al_insert: boolean;
      al_update: boolean;
      al_delete: boolean;
      al_truncate: boolean;
      log_insert: boolean;
    }[]
  >`
    SELECT
      has_schema_privilege('cbt_app', 'public', 'USAGE')   AS schema_usage,
      has_schema_privilege('cbt_app', 'public', 'CREATE')  AS schema_create,
      has_table_privilege('cbt_app', 'user_roles', 'SELECT') AS ur_select,
      has_table_privilege('cbt_app', 'user_roles', 'INSERT') AS ur_insert,
      has_table_privilege('cbt_app', 'user_roles', 'UPDATE') AS ur_update,
      has_table_privilege('cbt_app', 'user_roles', 'DELETE') AS ur_delete,
      has_table_privilege('cbt_app', 'audit_logs', 'INSERT') AS al_insert,
      has_table_privilege('cbt_app', 'audit_logs', 'UPDATE') AS al_update,
      has_table_privilege('cbt_app', 'audit_logs', 'DELETE') AS al_delete,
      has_table_privilege('cbt_app', 'audit_logs', 'TRUNCATE') AS al_truncate,
      has_table_privilege('cbt_app', 'role_change_log', 'INSERT') AS log_insert`;

  priv?.schema_usage && !priv.schema_create
    ? pass('cbt_app may use but not create schema objects')
    : fail('cbt_app may use but not create schema objects', JSON.stringify(priv));

  priv?.ur_select
    ? pass('cbt_app can read role grants')
    : fail('cbt_app can read role grants', 'SELECT missing');

  !priv?.ur_insert && !priv?.ur_update && !priv?.ur_delete
    ? pass('cbt_app cannot write role grants directly')
    : fail('cbt_app cannot write role grants directly', JSON.stringify(priv));

  priv?.al_insert && !priv?.al_update && !priv?.al_delete && !priv?.al_truncate
    ? pass('cbt_app can append but not rewrite the audit trail')
    : fail('cbt_app can append but not rewrite the audit trail', JSON.stringify(priv));

  !priv?.log_insert
    ? pass('role_change_log is written only by the privileged function')
    : fail('role_change_log is written only by the privileged function', 'INSERT granted to cbt_app');

  const fn = await prisma.$queryRaw<{ prosecdef: boolean; owner: string }[]>`
    SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p WHERE p.proname = 'app_set_roles'`;
  fn[0]?.prosecdef
    ? pass('app_set_roles is SECURITY DEFINER', fn[0].owner)
    : fail('app_set_roles is SECURITY DEFINER', 'missing or not SECURITY DEFINER');

  // --- direct writes as the runtime role must be refused --------------------
  await expectReject('cbt_app cannot insert a role grant directly', async (tx) => {
    const admin = await prisma.user.findFirstOrThrow({ where: { roles: { some: { role: { key: 'ADMIN' } } } } });
    const role = await prisma.role.findUniqueOrThrow({ where: { key: 'ADMIN' } });
    await tx.$executeRawUnsafe('SET LOCAL ROLE cbt_app');
    await tx.$executeRawUnsafe(
      `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
       VALUES (gen_random_uuid(), '${admin.id}', '${role.id}', 'GLOBAL', NULL)`,
    );
  });

  await expectReject('cbt_app cannot update the role catalogue', async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE cbt_app');
    await tx.$executeRawUnsafe(`UPDATE roles SET name = 'tampered' WHERE key = 'ADMIN'`);
  });

  await expectReject('cbt_app cannot delete audit rows', async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE cbt_app');
    await tx.$executeRawUnsafe('DELETE FROM audit_logs');
  });

  await expectReject('cbt_app cannot create tables', async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE cbt_app');
    await tx.$executeRawUnsafe('CREATE TABLE verify_should_fail (id int)');
  });

  await expectAllow('cbt_app can read role grants', async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE cbt_app');
    const rows = await tx.$queryRawUnsafe('SELECT count(*)::int AS n FROM user_roles');
    if (Number(rows[0]?.n) < 1) throw new Error('no rows visible');
  });

  // --- the gatekeeper -------------------------------------------------------
  const admin = await prisma.user.findFirstOrThrow({
    where: { roles: { some: { role: { key: 'ADMIN' } } } },
  });
  const student = await prisma.user.findFirstOrThrow({ where: { matricNo: { not: null } } });

  await expectReject('app_set_roles rejects a non-admin actor', async (tx) => {
    const sid = await makeSession(tx, student.id);
    await tx.$queryRaw`SELECT app_set_roles(${sid}::uuid, ${admin.id}::uuid, ARRAY['LECTURER']::text[])`;
  });

  await expectReject('app_set_roles rejects a revoked session', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$executeRaw`UPDATE auth_sessions SET revoked_at = now() WHERE id = ${sid}::uuid`;
    await tx.$queryRaw`SELECT app_set_roles(${sid}::uuid, ${student.id}::uuid, ARRAY['LECTURER']::text[])`;
  });

  await expectReject('app_set_roles rejects an actor whose account is deactivated', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$executeRaw`UPDATE users SET status = 'DEACTIVATED' WHERE id = ${admin.id}::uuid`;
    await tx.$queryRaw`SELECT app_set_roles(${sid}::uuid, ${student.id}::uuid, ARRAY['LECTURER']::text[])`;
  });

  await expectReject('app_set_roles rejects self role changes', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$queryRaw`SELECT app_set_roles(${sid}::uuid, ${admin.id}::uuid, ARRAY['LECTURER']::text[])`;
  });

  await expectReject('app_set_roles rejects a role outside the three', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$queryRaw`SELECT app_set_roles(${sid}::uuid, ${student.id}::uuid, ARRAY['PRINCIPAL']::text[])`;
  });

  await expectReject('app_set_roles rejects an empty role set', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$queryRaw`SELECT app_set_roles(${sid}::uuid, ${student.id}::uuid, ARRAY[]::text[])`;
  });

  await expectReject('app_set_roles rejects SC (non-GLOBAL) scope', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$queryRaw`
      SELECT app_set_roles(
        ${sid}::uuid, ${student.id}::uuid, ARRAY['LECTURER']::text[],
        'COLLEGE'::"ScopeType", gen_random_uuid(), 'verify-db')`;
  });

  let applied: string[] | null = null;
  await expectAllow('app_set_roles applies a valid GLOBAL change and logs it', async (tx) => {
    // The actor needs a live session to prove authority; the target needs one
    // so the function has something to revoke when the role changes.
    const targetSession = await makeSession(tx, student.id);
    const sid = await makeSession(tx, admin.id);
    const rows = await tx.$queryRaw`
      SELECT app_set_roles(${sid}::uuid, ${student.id}::uuid, ARRAY['LECTURER']::text[], 'GLOBAL'::"ScopeType", NULL, 'verify-db') AS roles`;
    applied = rows[0]?.roles ?? null;
    // Prisma may hand a text[] back either as an array or as its wire form;
    // String() makes this check independent of that.
    if (!applied || !String(applied).includes('LECTURER')) throw new Error('roles were not applied');

    const revoked = await tx.$queryRaw`
      SELECT revoked_reason FROM auth_sessions WHERE id = ${targetSession}::uuid`;
    if (revoked[0]?.revoked_reason !== 'ROLE_CHANGE') {
      throw new Error('the target session was not revoked on role change');
    }

    const log = await tx.$queryRaw`SELECT count(*)::int AS n FROM role_change_log`;
    if (Number(log[0]?.n) < 1) throw new Error('role_change_log was not written');
  });

  // --- append-only database log --------------------------------------------
  await expectReject('role_change_log rejects UPDATE', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$executeRawUnsafe(
      `INSERT INTO role_change_log (actor_id, target_id, before, after, session_id, request_id)
       VALUES ('${admin.id}', '${student.id}', ARRAY['STUDENT'], ARRAY['LECTURER'], '${sid}', 'verify')`,
    );
    await tx.$executeRawUnsafe(`UPDATE role_change_log SET request_id = 'tampered'`);
  });

  await expectReject('role_change_log rejects DELETE', async (tx) => {
    const sid = await makeSession(tx, admin.id);
    await tx.$executeRawUnsafe(
      `INSERT INTO role_change_log (actor_id, target_id, before, after, session_id, request_id)
       VALUES ('${admin.id}', '${student.id}', ARRAY['STUDENT'], ARRAY['LECTURER'], '${sid}', 'verify')`,
    );
    await tx.$executeRawUnsafe('DELETE FROM role_change_log');
  });
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('LASUSTECH CBT — database verification');
  await prisma.$queryRaw`SELECT 1`;

  await checkSchema();
  await checkIndexes();
  await checkSeed();
  await checkConstraints();
  await checkIdentitySecurity();

  section('Summary');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('\nVerification crashed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
