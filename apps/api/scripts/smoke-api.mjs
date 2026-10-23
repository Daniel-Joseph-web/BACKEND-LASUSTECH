/**
 * Black-box API smoke test against the seeded development database.
 *
 *   node scripts/smoke-api.mjs
 *
 * It starts the API itself (or reuses one already listening on PORT), then
 * exercises authentication, RBAC, admin/lecturer endpoints and refresh-token
 * rotation over real HTTP. No mocks: every request reaches Postgres.
 *
 * Switches (environment variables):
 *   SMOKE_WRITES=1  also create/update/delete disposable records
 *   SMOKE_IMPORT=1  also queue one CSV import and wait for the worker
 *   SMOKE_FRESH=1   never reuse a server already on PORT; fail instead
 *
 * Log: apps/api/smoke.log
 * Exit code 0 means every check passed.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');
const repoRoot = resolve(apiRoot, '../..');
const TS_NODE_REGISTER = resolve(repoRoot, 'node_modules/ts-node/register/transpile-only.js');
const LOG = resolve(apiRoot, 'smoke.log');
const PORT = process.env.PORT ?? '3001';
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.SEED_PASSWORD ?? 'ChangeMe123!';

writeFileSync(LOG, `LASUSTECH CBT — API smoke test — ${new Date().toISOString()}\n\n`, 'utf8');
const out = (text) => {
  process.stdout.write(text);
  appendFileSync(LOG, text, 'utf8');
};
const say = (text) => appendFileSync(LOG, text, 'utf8');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  out(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}\n`);
}

async function request(method, path, { token, body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  const refreshCookie = setCookies
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('refreshToken='));
  return { status: res.status, json, headers: res.headers, refreshCookie };
}

async function requestForm(path, { token, form, method = 'POST' } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

async function login(identifier, password = PASSWORD, portal) {
  const r = await request('POST', '/api/v1/auth/login', {
    body: { identifier, password, ...(portal ? { portal } : {}) },
  });
  return {
    status: r.status,
    json: r.json,
    token: r.json?.data?.accessToken,
    refreshCookie: r.refreshCookie,
  };
}

const healthy = async () => {
  try {
    const r = await fetch(`${BASE}/api/health/ready`);
    return r.status === 200;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------

let server = null;
let startedHere = false;

if (!(await healthy())) {
  out(`▸ Starting the API on port ${PORT}\n`);
  server = spawn(process.execPath, ['-r', TS_NODE_REGISTER, 'src/main.ts'], {
    cwd: apiRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => say(`[api] ${chunk}`));
  server.stderr.on('data', (chunk) => say(`[api] ${chunk}`));
  startedHere = true;

  let up = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await healthy()) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    out('FAIL  API did not become ready; see smoke.log for its output.\n');
    server.kill();
    process.exit(1);
  }
} else if (process.env.SMOKE_FRESH === '1') {
  // Opt-in strictness: refuse to test code that may not be the code on disk.
  out(
    `FAIL  SMOKE_FRESH=1 but something is already listening on port ${PORT}.\n` +
      '      Stop it (or unset SMOKE_FRESH) and run again.\n',
  );
  process.exit(1);
} else {
  out(`▸ Reusing the API already listening on port ${PORT}\n`);
}

try {
  // --- health -------------------------------------------------------------
  const live = await request('GET', '/api/health/live');
  check('health/live returns 200', live.status === 200, String(live.status));

  // A server that booted before the last `prisma generate` still holds the old
  // client object in memory, so every endpoint touching a new column 500s even
  // though the code and the database are correct. Say so here, once, instead of
  // letting it surface as dozens of unrelated failures below.
  const builtAt = live.json?.prismaClientBuiltAt;
  const bootedAt = live.json?.bootedAt;
  if (builtAt && bootedAt) {
    const stale = new Date(builtAt).getTime() > new Date(bootedAt).getTime();
    check(
      'running API booted after the last prisma generate',
      !stale,
      stale
        ? `generated client ${builtAt} is newer than API boot ${bootedAt} — stop the API and restart it`
        : `boot ${bootedAt}, client ${builtAt}`,
    );
  } else {
    // Do not let a broken diagnostic look like a pass.
    out('SKIP  prisma client build time not reported by /api/health/live\n');
  }

  const ready = await request('GET', '/api/health/ready');
  check(
    'health/ready reaches Postgres',
    ready.status === 200 && ready.json?.database === 'ok',
    String(ready.status),
  );
  // Not a code defect when this fails — it means Redis is not running, so
  // document import has nowhere to queue. Worth failing the run over: the API
  // answers 503 IMPORT_QUEUE_UNAVAILABLE until it is started.
  check(
    'job queue (Redis) is reachable',
    ready.json?.redis === 'ready',
    String(ready.json?.redis ?? 'not reported'),
  );

  // --- logins -------------------------------------------------------------
  // Exactly three roles, one portal each. `portal` is sent the way the login
  // screen sends it: a valid account must also hold the role of the entrance it
  // used, or the API answers 403 PORTAL_FORBIDDEN.
  const accounts = [
    ['admin@lasustech.edu.ng', 'ADMIN', 'admin'],
    ['bello@lasustech.edu.ng', 'LECTURER', 'lecturer'],
    ['nifemi@cbt.lasustech.edu.ng', 'STUDENT', 'student'],
  ];
  const sessions = {};
  for (const [email, role, portal] of accounts) {
    const r = await login(email, PASSWORD, portal);
    sessions[role] = r;
    check(`login ${role} through the ${portal} portal`, r.status === 200 && Boolean(r.token), `status ${r.status}`);
    check(`${role} receives a refresh cookie`, Boolean(r.refreshCookie));
    // The frontend's three portals (admin, lecturer, student) route on this
    // field, so it must agree with the account's highest-priority role.
    check(
      `${role} login reports primaryRole=${role}`,
      r.json?.data?.user?.primaryRole === role,
      String(r.json?.data?.user?.primaryRole),
    );
    check(
      `${role} login response carries no password hash`,
      !JSON.stringify(r.json ?? {}).includes('passwordHash'),
    );
  }

  // A correct password is not enough to enter a portal the account has no role
  // for. This is the "three login points" rule, checked on the server.
  const studentAtAdmin = await login('nifemi@cbt.lasustech.edu.ng', PASSWORD, 'admin');
  check(
    'student credentials are rejected at the admin portal',
    studentAtAdmin.status === 403 &&
      studentAtAdmin.json?.error?.code === 'PORTAL_FORBIDDEN' &&
      !studentAtAdmin.refreshCookie,
    `status ${studentAtAdmin.status}, code ${studentAtAdmin.json?.error?.code ?? 'none'}`,
  );

  const lecturerAtAdmin = await login('bello@lasustech.edu.ng', PASSWORD, 'admin');
  check(
    'lecturer credentials are rejected at the admin portal',
    lecturerAtAdmin.status === 403 && lecturerAtAdmin.json?.error?.code === 'PORTAL_FORBIDDEN',
    String(lecturerAtAdmin.status),
  );

  const adminAtStudent = await login('admin@lasustech.edu.ng', PASSWORD, 'student');
  check(
    'admin credentials are rejected at the student portal',
    adminAtStudent.status === 403 && adminAtStudent.json?.error?.code === 'PORTAL_FORBIDDEN',
    String(adminAtStudent.status),
  );

  const unknownPortal = await login('admin@lasustech.edu.ng', PASSWORD, 'principal');
  check(
    'an unknown portal is rejected',
    unknownPortal.status === 400 || unknownPortal.status === 422,
    String(unknownPortal.status),
  );

  // --- identity -----------------------------------------------------------
  for (const [email, role] of accounts) {
    const me = await request('GET', '/api/v1/me', { token: sessions[role].token });
    const roles = me.json?.data?.roles ?? [];
    check(`${role} /me reports its role`, me.status === 200 && roles.includes(role), `status ${me.status}, roles ${roles.join('|')}`);
  }

  // --- authentication failures -------------------------------------------
  const noToken = await request('GET', '/api/v1/admin/ping');
  check('admin without a token is rejected', noToken.status === 401, String(noToken.status));

  const tampered = await request('GET', '/api/v1/admin/ping', {
    token: `${sessions.ADMIN.token.slice(0, -2)}xx`,
  });
  check('tampered token is rejected', tampered.status === 401, String(tampered.status));

  const wrongPassword = await login('bello@lasustech.edu.ng', 'not-the-password');
  check('wrong password is rejected', wrongPassword.status === 401, String(wrongPassword.status));

  const unknownUser = await login('nobody@lasustech.edu.ng');
  check('unknown account is rejected', unknownUser.status === 401, String(unknownUser.status));

  const malformed = await request('POST', '/api/v1/auth/login', { body: {} });
  check(
    'malformed login is rejected',
    [400, 422].includes(malformed.status) && malformed.json?.error?.code === 'VALIDATION_FAILED',
    `${malformed.status} ${malformed.json?.error?.code ?? ''}`,
  );

  // citext: the same address in a different case must still authenticate.
  const upperCase = await login('ADMIN@LASUSTECH.EDU.NG');
  check('email login is case-insensitive (citext)', upperCase.status === 200 && Boolean(upperCase.token), String(upperCase.status));

  // --- RBAC ---------------------------------------------------------------
  for (const role of ['LECTURER', 'STUDENT']) {
    const r = await request('GET', '/api/v1/admin/ping', { token: sessions[role].token });
    check(`${role} is denied /admin`, r.status === 403, String(r.status));
  }
  const adminPing = await request('GET', '/api/v1/admin/ping', { token: sessions.ADMIN.token });
  check('ADMIN reaches /admin', adminPing.status === 200 && adminPing.json?.data === 'pong', String(adminPing.status));
  check('admin responses are not cacheable', /no-store/.test(adminPing.headers.get('cache-control') ?? ''), adminPing.headers.get('cache-control') ?? 'none');

  for (const role of ['STUDENT']) {
    const r = await request('GET', '/api/v1/lecturer/courses', { token: sessions[role].token });
    check(`${role} is denied /lecturer`, r.status === 403, String(r.status));
  }
  const lecturerAtLecturer = await request('GET', '/api/v1/lecturer/courses', {
    token: sessions.LECTURER.token,
  });
  check('LECTURER reaches /lecturer', lecturerAtLecturer.status === 200, String(lecturerAtLecturer.status));

  // The database gatekeeper refuses self role changes; the API surfaces that as
  // a conflict rather than a raw privilege error.
  const selfRole = await request('PATCH', `/api/v1/admin/users/${sessions.ADMIN.json?.data?.user?.id}`, {
    token: sessions.ADMIN.token,
    body: { roles: ['ADMIN', 'LECTURER'] },
  });
  check(
    'admin cannot change their own roles',
    selfRole.status === 409 && selfRole.json?.error?.code === 'SELF_ROLE_CHANGE',
    `${selfRole.status} ${selfRole.json?.error?.code ?? ''}`,
  );

  // --- admin endpoints ----------------------------------------------------
  const dashboard = await request('GET', '/api/v1/admin/dashboard', { token: sessions.ADMIN.token });
  check('admin dashboard loads', dashboard.status === 200, String(dashboard.status));

  const users = await request('GET', '/api/v1/admin/users', { token: sessions.ADMIN.token });
  check('admin user list loads', users.status === 200 && Array.isArray(users.json?.data), String(users.status));

  const searched = await request('GET', '/api/v1/admin/users?search=admin', { token: sessions.ADMIN.token });
  check('admin user search (trigram path) loads', searched.status === 200, String(searched.status));

  // --- Lecturer Course Assignment & Role Functionality ---
  const lecturerId = sessions.LECTURER.json?.data?.user?.id;
  const lecturerUserCourses = await request('GET', `/api/v1/admin/users/${lecturerId}/courses`, { token: sessions.ADMIN.token });
  check('admin can fetch lecturer course assignments', lecturerUserCourses.status === 200 && Array.isArray(lecturerUserCourses.json?.data?.assignments), String(lecturerUserCourses.status));

  const coursesList = await request('GET', '/api/v1/admin/courses', { token: sessions.ADMIN.token });
  if (coursesList.status === 200 && coursesList.json?.data?.length > 0) {
    const firstCourseId = coursesList.json.data[0].id;
    const assignRes = await request('PUT', `/api/v1/admin/users/${lecturerId}/courses`, {
      token: sessions.ADMIN.token,
      body: { courseIds: [firstCourseId] },
    });
    check('admin can assign courses to lecturer via /users/:id/courses', assignRes.status === 200 && assignRes.json?.data?.assignedCount === 1, `status ${assignRes.status}`);

    const lecturerCoursesInPortal = await request('GET', '/api/v1/lecturer/courses', { token: sessions.LECTURER.token });
    check('lecturer sees assigned course in portal', lecturerCoursesInPortal.status === 200 && lecturerCoursesInPortal.json?.data?.some((c) => c.id === firstCourseId), String(lecturerCoursesInPortal.status));
  }

  const structure = await request('GET', '/api/v1/admin/structure', { token: sessions.ADMIN.token });
  check('admin structure returns 5 colleges', structure.status === 200 && structure.json?.data?.length === 5, `status ${structure.status}, got ${structure.json?.data?.length}`);

  const sessionsList = await request('GET', '/api/v1/admin/sessions', { token: sessions.ADMIN.token });
  check('admin sessions load', sessionsList.status === 200, String(sessionsList.status));

  const audit = await request('GET', '/api/v1/admin/audit?pageSize=10', { token: sessions.ADMIN.token });
  check('admin audit list loads', audit.status === 200, String(audit.status));

  const chain = await request('GET', '/api/v1/admin/audit/verify', { token: sessions.ADMIN.token });
  check('audit hash chain verifies', chain.status === 200 && chain.json?.data?.ok === true, JSON.stringify(chain.json?.data ?? null));

  // --- admin console wiring (schedule, live proctoring, incidents, reports) --
  const adminGet = (path) => request('GET', `/api/v1${path}`, { token: sessions.ADMIN.token });

  const exams = await adminGet('/admin/exams');
  check('admin schedulable exams load', exams.status === 200 && Array.isArray(exams.json?.data), String(exams.status));

  const venues = await adminGet('/admin/venues');
  check('admin venues load', venues.status === 200 && Array.isArray(venues.json?.data), String(venues.status));

  const invigilators = await adminGet('/admin/invigilators');
  check('admin invigilators load', invigilators.status === 200 && Array.isArray(invigilators.json?.data), String(invigilators.status));

  const schedule = await adminGet('/admin/schedule?pageSize=10');
  check(
    'admin schedule loads with counters',
    schedule.status === 200 &&
      Array.isArray(schedule.json?.data) &&
      typeof schedule.json?.meta?.counts?.scheduled === 'number',
    `${schedule.status} ${JSON.stringify(schedule.json?.meta?.counts ?? null)}`,
  );

  const liveList = await adminGet('/admin/live?status=ALL');
  check(
    "live console lists today's sittings",
    liveList.status === 200 &&
      Array.isArray(liveList.json?.data) &&
      typeof liveList.json?.meta?.counts?.sessions === 'number',
    `${liveList.status} ${JSON.stringify(liveList.json?.meta?.counts ?? null)}`,
  );

  const todaysSitting = liveList.json?.data?.[0];
  if (todaysSitting) {
    const detail = await adminGet(`/admin/live/${todaysSitting.id}`);
    check(
      'live terminal grid loads a sitting',
      detail.status === 200 &&
        detail.json?.data?.sitting?.id === todaysSitting.id &&
        Array.isArray(detail.json?.data?.students),
      String(detail.status),
    );

    const proctorCsv = await request('GET', `/api/v1/admin/live/${todaysSitting.id}/export`, {
      token: sessions.ADMIN.token,
    });
    check(
      'proctor log exports CSV',
      proctorCsv.status === 200 && /text\/csv/.test(proctorCsv.headers.get('content-type') ?? ''),
      `${proctorCsv.status} ${proctorCsv.headers.get('content-type') ?? ''}`,
    );
  } else {
    say('SKIP  live terminal grid: no sitting scheduled for today\n');
  }

  const missingSitting = await adminGet(`/admin/live/${randomUUID()}`);
  check('unknown sitting is 404', missingSitting.status === 404, String(missingSitting.status));

  const incidents = await adminGet('/admin/incidents?pageSize=10');
  check(
    'incident dockets load with counters',
    incidents.status === 200 &&
      Array.isArray(incidents.json?.data) &&
      typeof incidents.json?.meta?.counts?.open === 'number',
    `${incidents.status} ${JSON.stringify(incidents.json?.meta?.counts ?? null)}`,
  );

  const incidentsCsv = await adminGet('/admin/incidents/export');
  check(
    'incident log exports CSV',
    incidentsCsv.status === 200 && /text\/csv/.test(incidentsCsv.headers.get('content-type') ?? ''),
    `${incidentsCsv.status} ${incidentsCsv.headers.get('content-type') ?? ''}`,
  );

  const incidentFeed = await adminGet('/admin/reports/incidents?limit=10');
  check(
    'reports incident feed loads',
    incidentFeed.status === 200 && Array.isArray(incidentFeed.json?.data),
    String(incidentFeed.status),
  );

  // --- optional write paths (set SMOKE_WRITES=1) --------------------------
  // These create real rows in the development database, so they are opt-in.
  if (process.env.SMOKE_WRITES === '1') {
    const created = await request('POST', '/api/v1/admin/incidents', {
      token: sessions.ADMIN.token,
      body: {
        category: 'TECHNICAL',
        severity: 'LOW',
        description: `Smoke test docket ${new Date().toISOString()}`,
      },
    });
    check(
      'incident docket can be created',
      created.status === 201 && /^INC-\d{4}-\d{3,}$/.test(created.json?.data?.referenceNo ?? ''),
      `${created.status} ${created.json?.data?.referenceNo ?? ''}`,
    );

    const incidentId = created.json?.data?.id;
    if (incidentId) {
      const resolved = await request('PATCH', `/api/v1/admin/incidents/${incidentId}`, {
        token: sessions.ADMIN.token,
        body: { status: 'RESOLVED', resolutionNote: 'Closed by the smoke test.' },
      });
      check(
        'incident docket can be resolved',
        resolved.status === 200 &&
          resolved.json?.data?.status === 'RESOLVED' &&
          Boolean(resolved.json?.data?.resolvedAt),
        `${resolved.status} ${resolved.json?.data?.status ?? ''}`,
      );
    }
  } else {
    say('SKIP  incident write path (set SMOKE_WRITES=1 to exercise it)\n');
  }

  // --- lecturer endpoints -------------------------------------------------
  const lecturerSummary = await request('GET', '/api/v1/lecturer/dashboard/summary', { token: sessions.LECTURER.token });
  check('lecturer dashboard loads', lecturerSummary.status === 200, String(lecturerSummary.status));

  const lecturerCourses = await request('GET', '/api/v1/lecturer/courses', { token: sessions.LECTURER.token });
  check('lecturer courses load', lecturerCourses.status === 200, String(lecturerCourses.status));

  const lecturerQuestions = await request('GET', '/api/v1/lecturer/questions', { token: sessions.LECTURER.token });
  check('lecturer questions load', lecturerQuestions.status === 200, String(lecturerQuestions.status));

  // --- lecturer: subjects, media, exams, public exams ---------------------
  const lecturerGet = (path) => request('GET', `/api/v1${path}`, { token: sessions.LECTURER.token });

  const subjectsList = await lecturerGet('/lecturer/subjects');
  check('lecturer subjects load', subjectsList.status === 200 && Array.isArray(subjectsList.json?.data), String(subjectsList.status));

  const questionSummary = await lecturerGet('/lecturer/questions/summary');
  check('question summary loads', questionSummary.status === 200 && typeof questionSummary.json?.data?.total === 'number', String(questionSummary.status));

  const template = await lecturerGet('/lecturer/questions/template');
  check('import template downloads', template.status === 200 && typeof template.json === 'string' && template.json.includes('ANSWER:'), String(template.status));

  // The course branch of assertExamAccess/assertScopeAccess was never reached
  // (the write flow below uses a subject), which is how an impossible
  // `select: { id: true }` on the composite-key CourseAssignment survived a
  // green run. Cover it explicitly.
  const firstCourseId = lecturerCourses.json?.data?.[0]?.id;
  if (firstCourseId) {
    const scopedQuestions = await lecturerGet(`/lecturer/questions?courseId=${firstCourseId}`);
    check(
      'lecturer questions filter by an assigned course',
      scopedQuestions.status === 200,
      String(scopedQuestions.status),
    );

    const coursePool = await lecturerGet(`/lecturer/questions/available?courseId=${firstCourseId}`);
    check(
      'question pool size loads for an assigned course',
      coursePool.status === 200,
      String(coursePool.status),
    );
  } else {
    out('SKIP  the seeded lecturer has no course assignment\n');
  }

  const foreignCourse = await lecturerGet(`/lecturer/questions/available?courseId=${randomUUID()}`);
  check(
    'question pool for a course the lecturer does not teach is refused',
    foreignCourse.status === 403,
    String(foreignCourse.status),
  );

  const examsList = await lecturerGet('/lecturer/exams');
  check('lecturer exams load', examsList.status === 200 && Array.isArray(examsList.json?.data), String(examsList.status));

  const unknownExam = await lecturerGet(`/lecturer/exams/${randomUUID()}`);
  check('unknown exam is 404', unknownExam.status === 404, String(unknownExam.status));

  for (const path of ['/lecturer/subjects', '/lecturer/exams', '/lecturer/questions/summary']) {
    const denied = await request('GET', `/api/v1${path}`, { token: sessions.STUDENT.token });
    check(`STUDENT is denied ${path}`, denied.status === 403, String(denied.status));
  }

  // --- write flows (set SMOKE_WRITES=1) -----------------------------------
  // These create real rows. The sat public exam cannot be deleted through the
  // API by design, so one public exam per run is left in the dev database.
  if (process.env.SMOKE_WRITES !== '1') {
    say('SKIP  subject/media/question/exam/public-exam write flow (set SMOKE_WRITES=1)\n');
  } else {
    const createdSittings = [];
    let disposableExamId = null;
    try {
      const stamp = Date.now().toString(36);

      // 1. A subject is the non-university escape hatch: no course needed.
      const subjectName = `Smoke Subject ${stamp}`;
      const subject = await request('POST', '/api/v1/lecturer/subjects', {
        token: sessions.LECTURER.token,
        body: {
          name: subjectName,
          code: `SMK-${stamp}`,
          level: 'SS 2',
          institution: 'Smoke Grammar School',
          category: 'SECONDARY',
        },
      });
      check('subject can be created', subject.status === 201 && Boolean(subject.json?.data?.id), `${subject.status} ${subject.json?.error?.code ?? ''}`);
      const subjectId = subject.json?.data?.id;

      if (subjectId) {
        const renamed = await request('PATCH', `/api/v1/lecturer/subjects/${subjectId}`, {
          token: sessions.LECTURER.token,
          body: { name: `${subjectName} (renamed)` },
        });
        check('subject can be renamed', renamed.status === 200 && String(renamed.json?.data?.name).endsWith('(renamed)'), String(renamed.status));
      }

      // 2. A question photo, uploaded once and served publicly by content hash.
      const pixel = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const mediaForm = new FormData();
      mediaForm.append('file', new Blob([pixel], { type: 'image/png' }), `smoke-${stamp}.png`);
      const uploaded = await requestForm('/api/v1/lecturer/media', { token: sessions.LECTURER.token, form: mediaForm });
      check('image upload returns a media id', [200, 201].includes(uploaded.status) && Boolean(uploaded.json?.data?.id), `${uploaded.status} ${uploaded.json?.error?.code ?? ''}`);
      const mediaId = uploaded.json?.data?.id;

      if (mediaId) {
        const served = await fetch(`${BASE}/api/v1/media/${mediaId}`);
        check(
          'media is served publicly to anonymous clients',
          served.status === 200 && /image\/png/.test(served.headers.get('content-type') ?? ''),
          `${served.status} ${served.headers.get('content-type') ?? ''}`,
        );
        check(
          'media is immutably cacheable',
          /immutable/.test(served.headers.get('cache-control') ?? ''),
          served.headers.get('cache-control') ?? 'none',
        );
      }

      // 3. A question carrying a stem photo and an option photo.
      const question = await request('POST', '/api/v1/lecturer/questions', {
        token: sessions.LECTURER.token,
        body: {
          subjectId,
          answerFormat: 'MCQ_SINGLE',
          difficulty: 'EASY',
          marks: 1,
          stem: { text: `Smoke question ${stamp}?` },
          stemMediaId: mediaId ?? undefined,
          explanation: 'Created by the API smoke test.',
          options: [
            { position: 0, body: { text: 'Correct' }, isCorrect: true, mediaId: mediaId ?? undefined },
            { position: 1, body: { text: 'Wrong' }, isCorrect: false },
          ],
        },
      });
      check('question with photos can be created', question.status === 201 && Boolean(question.json?.data?.id), `${question.status} ${question.json?.error?.code ?? ''}`);
      const questionId = question.json?.data?.id;

      if (questionId) {
        const detail = await lecturerGet(`/lecturer/questions/${questionId}`);
        const version = detail.json?.data?.version;
        check(
          'question detail returns media URLs',
          detail.status === 200 && Boolean(version?.stemMediaUrl) && Boolean(version?.options?.[0]?.mediaUrl),
          `${detail.status} stem=${version?.stemMediaUrl ?? 'none'}`,
        );
        check(
          'created question is approved with lecturer provenance',
          version?.status === 'APPROVED' && version?.answerSource === 'LECTURER',
          `${version?.status ?? 'none'}/${version?.answerSource ?? 'none'}`,
        );
      }

      // 4. A public exam built from that question, protected by an access code.
      const examBody = (title, durationMin) => ({
        subjectId,
        title,
        kind: 'CUSTOM',
        kindLabel: 'Smoke test',
        audience: 'PUBLIC',
        durationMin,
        passMark: 50,
        settings: {
          shuffleQuestions: false,
          shuffleOptions: false,
          showResults: true,
          gradeBands: [
            { grade: 'A', minPercent: 70, maxPercent: 100 },
            { grade: 'B', minPercent: 60, maxPercent: 69.99 },
            { grade: 'C', minPercent: 50, maxPercent: 59.99 },
            { grade: 'F', minPercent: 0, maxPercent: 49.99 },
          ],
        },
        sections: [
          { title: 'Section A', rules: [{ mode: 'FIXED', count: 1, marks: 1, questionIds: [questionId] }] },
        ],
        accessCode: 'smoke-pass',
      });

      const published = await request('POST', '/api/v1/lecturer/exams', {
        token: sessions.LECTURER.token,
        body: examBody(`Smoke Public Exam ${stamp}`, 30),
      });
      check(
        'public exam publishes immediately with a shareable slug',
        published.status === 201 && Boolean(published.json?.data?.exam?.publicSlug) && Boolean(published.json?.data?.publicUrl),
        `${published.status} ${published.json?.error?.code ?? ''}`,
      );
      const examId = published.json?.data?.exam?.id;
      const slug = published.json?.data?.exam?.publicSlug;

      if (examId) {
        const examDetail = await lecturerGet(`/lecturer/exams/${examId}`);
        check(
          'exam detail returns the materialised paper',
          examDetail.status === 200 && examDetail.json?.data?.sections?.[0]?.questions?.length === 1,
          `${examDetail.status} ${examDetail.json?.data?.sections?.[0]?.questions?.length ?? 'none'}`,
        );
      }

      // 5. The candidate flow: metadata, code gate, start, save, submit.
      if (slug) {
        const meta = await request('GET', `/api/v1/public/exams/${slug}`);
        check(
          'public exam metadata loads anonymously',
          meta.status === 200 && meta.json?.data?.requiresCode === true && meta.json?.data?.questionCount === 1,
          `${meta.status} code=${meta.json?.data?.requiresCode} questions=${meta.json?.data?.questionCount}`,
        );

        const email = `smoke-${stamp}@example.test`;

        const noCode = await request('POST', `/api/v1/public/exams/${slug}/start`, {
          body: { name: 'Smoke Candidate', email },
        });
        check(
          'start without the access code is refused',
          noCode.status === 400 && noCode.json?.error?.code === 'ACCESS_CODE_REQUIRED',
          `${noCode.status} ${noCode.json?.error?.code ?? ''}`,
        );

        const started = await request('POST', `/api/v1/public/exams/${slug}/start`, {
          body: { name: 'Smoke Candidate', email, accessCode: 'smoke-pass' },
        });
        check(
          'candidate can start the public exam',
          started.status === 201 && Boolean(started.json?.data?.token),
          `${started.status} ${started.json?.error?.code ?? ''}`,
        );
        const attempt = started.json?.data;

        if (attempt?.token) {
          const paper = await request('GET', `/api/v1/public/attempts/${attempt.attemptId}`, { token: attempt.token });
          const first = paper.json?.data?.questions?.[0];
          check('attempt paper loads for the candidate', paper.status === 200 && Boolean(first), String(paper.status));
          check(
            'the paper never leaks the answer key',
            !JSON.stringify(paper.json ?? {}).includes('isCorrect') && first?.options?.length === 2,
            `${first?.options?.length ?? 'none'} options`,
          );

          if (first) {
            const saved = await request('PUT', `/api/v1/public/attempts/${attempt.attemptId}/answers`, {
              token: attempt.token,
              body: { questionVersionId: first.questionVersionId, positions: [first.options[0].position] },
            });
            check(
              'candidate answer saves',
              saved.status === 200 && saved.json?.data?.positions?.[0] === first.options[0].position,
              String(saved.status),
            );

            const submitted = await request('POST', `/api/v1/public/attempts/${attempt.attemptId}/submit`, {
              token: attempt.token,
            });
            const score = submitted.json?.data ?? null;
            check(
              'attempt submits and scores',
              submitted.status === 200 && typeof score?.percent === 'number' && typeof score?.passed === 'boolean',
              `${submitted.status} ${JSON.stringify(score).slice(0, 140)}`,
            );

            const repeat = await request('POST', `/api/v1/public/attempts/${attempt.attemptId}/submit`, {
              token: attempt.token,
            });
            check('repeat submit is idempotent', repeat.status === 200 && repeat.json?.data?.alreadySubmitted === true, String(repeat.status));

            const retake = await request('POST', `/api/v1/public/exams/${slug}/start`, {
              body: { name: 'Smoke Candidate', email, accessCode: 'smoke-pass' },
            });
            check(
              'one attempt per email per exam',
              retake.status === 409 && retake.json?.error?.code === 'ALREADY_TAKEN',
              `${retake.status} ${retake.json?.error?.code ?? ''}`,
            );

            const results = await lecturerGet(`/lecturer/exams/${examId}/results`);
            check(
              'results include the public candidate',
              results.status === 200 && Number(results.json?.data?.summary?.totalStudents) >= 1,
              `${results.status} ${results.json?.data?.summary?.totalStudents ?? 'none'}`,
            );

            const csv = await request('GET', `/api/v1/lecturer/exams/${examId}/results/export/csv`, {
              token: sessions.LECTURER.token,
            });
            check(
              'results export CSV',
              csv.status === 200 && typeof csv.json === 'string' && csv.json.includes('Percentage'),
              String(csv.status),
            );

            // The /lecturer/results index lists papers with a candidate count
            // taken through each sitting's attempts.
            const indexPath = await lecturerGet('/lecturer/exams');
            const listed = (indexPath.json?.data ?? []).find((row) => row.id === examId);
            check(
              'exam list reports the candidate count used by the results index',
              indexPath.status === 200 && Number(listed?.attemptCount) >= 1,
              `${indexPath.status} attemptCount=${listed?.attemptCount ?? 'none'}`,
            );
          }
        }
      }

      // 6. Admin timetable: no venue, and only one school sitting at a time.
      const schedulable = await adminGet('/admin/exams');
      const target = (schedulable.json?.data ?? [])[0];
      if (target) {
        const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        startsAt.setUTCMinutes(0, 0, 0);

        const firstSitting = await request('POST', '/api/v1/admin/schedule', {
          token: sessions.ADMIN.token,
          body: { examId: target.id, startsAt: startsAt.toISOString(), durationMin: 60 },
        });
        check(
          'a sitting can be scheduled without a venue',
          [200, 201].includes(firstSitting.status),
          `${firstSitting.status} ${firstSitting.json?.error?.code ?? ''}`,
        );
        const sittingId = firstSitting.json?.data?.id ?? firstSitting.json?.data?.sitting?.id;
        if (sittingId) createdSittings.push(sittingId);

        const clash = await request('POST', '/api/v1/admin/schedule', {
          token: sessions.ADMIN.token,
          body: {
            examId: target.id,
            startsAt: new Date(startsAt.getTime() + 15 * 60 * 1000).toISOString(),
            durationMin: 60,
          },
        });
        check(
          'an overlapping sitting is refused with TIME_CLASH',
          clash.status === 409 && clash.json?.error?.code === 'TIME_CLASH',
          `${clash.status} ${clash.json?.error?.code ?? ''}`,
        );

        const listed = await adminGet('/admin/schedule?pageSize=100&status=ALL');
        const ours = (listed.json?.data ?? []).find((s) => s.id === sittingId);
        check(
          'the new sitting is listed with venue=null',
          listed.status === 200 && Boolean(ours) && ours.venue == null,
          `${listed.status} ${ours ? `venue=${JSON.stringify(ours.venue)}` : 'not listed'}`,
        );

        const publicExamIsHidden =
          Boolean(examId) && (schedulable.json?.data ?? []).every((e) => e.id !== examId);
        check('public exams never appear as schedulable', publicExamIsHidden);
      } else {
        say('SKIP  timetable write flow: no institutional exam is schedulable\n');
      }

      // 7. Only a never-sat exam can be deleted.
      const disposable = await request('POST', '/api/v1/lecturer/exams', {
        token: sessions.LECTURER.token,
        body: examBody(`Smoke Disposable ${stamp}`, 10),
      });
      disposableExamId = disposable.json?.data?.exam?.id ?? null;
      if (disposableExamId) {
        const removed = await request('DELETE', `/api/v1/lecturer/exams/${disposableExamId}`, {
          token: sessions.LECTURER.token,
        });
        check('a never-sat exam can be deleted', removed.status === 200 || removed.status === 204, String(removed.status));
        if (removed.status === 200 || removed.status === 204) disposableExamId = null;
      }

      if (examId) {
        const inUse = await request('DELETE', `/api/v1/lecturer/exams/${examId}`, {
          token: sessions.LECTURER.token,
        });
        check(
          'a sat exam cannot be deleted',
          inUse.status === 409 && inUse.json?.error?.code === 'EXAM_IN_USE',
          `${inUse.status} ${inUse.json?.error?.code ?? ''}`,
        );
      }

      // 8. Import needs Redis and a running worker.
      if (process.env.SMOKE_IMPORT === '1' && subjectId) {
        const csv = 'Question,Option A,Option B,Correct Answer\nWhat is 2+2?,3,4,B\n';
        const importForm = new FormData();
        importForm.append('file', new Blob([csv], { type: 'text/csv' }), 'smoke-import.csv');
        importForm.append('subjectId', subjectId);

        const queued = await requestForm('/api/v1/lecturer/questions/import', {
          token: sessions.LECTURER.token,
          form: importForm,
        });
        check(
          'import job is queued',
          queued.status === 202 && Boolean(queued.json?.data?.jobId),
          `${queued.status} ${queued.json?.error?.code ?? ''}`,
        );

        const jobId = queued.json?.data?.jobId;
        if (jobId) {
          const deadline = Date.now() + 60_000;
          let status = 'QUEUED';
          let detail = null;
          while (Date.now() < deadline) {
            const poll = await lecturerGet(`/lecturer/questions/import/${jobId}`);
            detail = poll.json?.data ?? null;
            status = detail?.status ?? status;
            if (status !== 'QUEUED' && status !== 'PROCESSING') break;
            await new Promise((r) => setTimeout(r, 2000));
          }
          check('import completes through the worker', status === 'COMPLETED', `${status} ${detail?.errors ? JSON.stringify(detail.errors).slice(0, 120) : ''}`);
          check(
            'import reports counts',
            status === 'COMPLETED' && Number(detail?.counts?.imported) >= 1,
            JSON.stringify(detail?.counts ?? null).slice(0, 160),
          );
        }
      } else {
        say('SKIP  import flow (set SMOKE_IMPORT=1 with Redis and the worker running)\n');
      }
    } finally {
      // Best-effort cleanup: timetabled sittings we created are removed so the
      // next run starts from the same state.
      for (const sittingId of createdSittings) {
        try {
          await request('DELETE', `/api/v1/admin/schedule/${sittingId}`, { token: sessions.ADMIN.token });
        } catch {
          /* leave it for manual cleanup */
        }
      }
      if (disposableExamId) {
        try {
          await request('DELETE', `/api/v1/lecturer/exams/${disposableExamId}`, { token: sessions.LECTURER.token });
        } catch {
          /* leave it for manual cleanup */
        }
      }
    }
  }

  // --- refresh-token rotation --------------------------------------------
  const rotated = await request('POST', '/api/v1/auth/refresh', { cookie: sessions.STUDENT.refreshCookie });
  check('refresh rotates the token', rotated.status === 200 && Boolean(rotated.json?.data?.accessToken), String(rotated.status));

  const reused = await request('POST', '/api/v1/auth/refresh', { cookie: sessions.STUDENT.refreshCookie });
  check('reusing a rotated refresh token is rejected', reused.status === 401, String(reused.status));

  const loggedOut = await request('POST', '/api/v1/auth/logout', { cookie: rotated.refreshCookie });
  check('logout succeeds', loggedOut.status === 204, String(loggedOut.status));

  const afterLogout = await request('POST', '/api/v1/auth/refresh', { cookie: rotated.refreshCookie });
  check('refresh after logout is rejected', afterLogout.status === 401, String(afterLogout.status));

  // --- error shape --------------------------------------------------------
  const errorBody = noToken.json?.error;
  check('errors carry a code and message', Boolean(errorBody?.code && errorBody?.message));
  check('errors do not leak a stack', !JSON.stringify(noToken.json ?? {}).includes('at '));
} finally {
  if (startedHere && server) {
    server.kill();
    await new Promise((r) => setTimeout(r, 800));
    if (!server.killed) server.kill('SIGKILL');
  }
}

const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
out(`Log: ${LOG}\n`);
process.exit(failed.length ? 1 : 0);
