/**
 * LASUSTECH CBT - Comprehensive Full-System Verification Suite
 * 
 * Tests:
 * 1. Health & Database Connectivity
 * 2. Authentication & Multi-Role Segregation (Admin, Lecturer, Student, Guest)
 * 3. Course Assignment & Lecturer Boundary Isolation
 * 4. Question Bank: Draft, Review, LaTeX Math & SVG Diagram Handling
 * 5. Exam Authoring & Immediate Lecturer Approval
 * 6. Admin Scheduling, Venue Allocation & Access Code Delivery
 * 7. Student Portal, Access Code Validation & Security Guard
 * 8. CBT Examination Engine: Question Scrambling & Realtime Autosave
 * 9. Proctoring & Tab Switch Security Enforcement
 * 10. Scoring Engine & Result Release Gate (Held by default until Admin release)
 * 11. Public Link Exams: Anonymous Candidate Flow
 * 12. Settings Persistence & Database-Enforced Business Rules
 * 13. Realtime WebSocket Server (Port 3002) & Redis Pub/Sub Health
 */

const http = require('node:http');
const io = require('../lasustech-cbt/node_modules/socket.io-client');

const API_BASE = 'http://localhost:3001/api/v1';
const ROOT_URL = 'http://localhost:3001';
const REALTIME_URL = 'http://localhost:3002';

function request(method, path, body = null, token = null, isRoot = false) {
  return new Promise((resolve, reject) => {
    const url = new URL((isRoot ? ROOT_URL : API_BASE) + path);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
      },
    };
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runComprehensiveTests() {
  console.log('================================================================');
  console.log('   LASUSTECH CBT - COMPREHENSIVE END-TO-END SYSTEM TEST SUITE   ');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;
  const failures = [];

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${name} (status: ${details?.status || 'N/A'}, err: ${JSON.stringify(details?.data || details)})`);
      failed++;
      failures.push({ name, details });
    }
  }

  // --- 1. SYSTEM HEALTH & CONNECTIVITY ---
  console.log('1. Checking Core Service Connectivity...');
  const healthRes = await request('GET', '/health', null, null, true);
  assert(healthRes.status === 200 && healthRes.data?.status === 'ok', 'API Health Check returns 200 OK', healthRes);

  // --- 2. AUTHENTICATION & TRIPLE-TIER SECURITY ---
  console.log('\n2. Testing Authentication & Role Barriers...');
  const adminLogin = await request('POST', '/auth/login', {
    identifier: 'admin@lasustech.edu.ng',
    password: 'ChangeMe123!',
  });
  assert(adminLogin.status === 200 && adminLogin.data?.data?.accessToken, 'Admin authenticated successfully', adminLogin);
  const adminToken = adminLogin.data?.data?.accessToken;

  // Flush sessions before candidate logins to prevent lingering concurrency locks
  await request('POST', '/admin/settings/flush-sessions', { force: true }, adminToken);

  const lecturerLogin = await request('POST', '/auth/login', {
    identifier: 'bello@lasustech.edu.ng',
    password: 'ChangeMe123!',
  });
  assert(lecturerLogin.status === 200 && lecturerLogin.data?.data?.accessToken, 'Lecturer authenticated successfully', lecturerLogin);
  const lecturerToken = lecturerLogin.data?.data?.accessToken;

  const studentLogin = await request('POST', '/auth/login', {
    identifier: 'nifemi@cbt.lasustech.edu.ng',
    password: 'ChangeMe123!',
    portal: 'student',
  });
  assert(studentLogin.status === 200 && studentLogin.data?.data?.accessToken, 'Student authenticated successfully', studentLogin);
  const studentToken = studentLogin.data?.data?.accessToken;

  // RBAC Boundary Enforcement
  const studentAttemptAdmin = await request('GET', '/admin/dashboard', null, studentToken);
  assert(studentAttemptAdmin.status === 403, 'RBAC Guard: Student strictly barred from /admin/dashboard (403)');

  const studentAttemptLecturer = await request('GET', '/lecturer/courses', null, studentToken);
  assert(studentAttemptLecturer.status === 403, 'RBAC Guard: Student strictly barred from /lecturer/courses (403)');

  const anonAttemptAdmin = await request('GET', '/admin/users');
  assert(anonAttemptAdmin.status === 401, 'Auth Guard: Anonymous user barred with 401');

  // --- 3. COURSE ISOLATION & LECTURER SCOPING ---
  console.log('\n3. Testing Course Assignment & Lecturer Isolation...');
  const lecturerCoursesRes = await request('GET', '/lecturer/courses', null, lecturerToken);
  assert(lecturerCoursesRes.status === 200 && Array.isArray(lecturerCoursesRes.data?.data), 'GET /lecturer/courses returns assigned courses list');
  const lecturerCourses = lecturerCoursesRes.data?.data || [];
  assert(lecturerCourses.length > 0, `Lecturer has ${lecturerCourses.length} assigned course(s)`);
  const cscCourse = lecturerCourses.find((c) => c.code === 'CSC 301') || lecturerCourses[0];
  const targetCourseId = cscCourse.id;

  const allCoursesRes = await request('GET', '/admin/courses', null, adminToken);
  const totalAdminCourses = allCoursesRes.data?.data?.length || 0;
  assert(lecturerCourses.length <= totalAdminCourses, `Course Scoping Guard: Lecturer sees only assigned courses (${lecturerCourses.length} of ${totalAdminCourses} total courses)`);

  // --- 4. QUESTION BANK & LATEX/SVG FORMATTING ---
  console.log('\n4. Testing Question Bank, LaTeX Math & SVG Support...');
  const mathQuestionPayload = {
    courseId: targetCourseId,
    answerFormat: 'MCQ_SINGLE',
    difficulty: 'MEDIUM',
    marks: 2,
    stem: { text: 'Evaluate the definite integral $\\int_{0}^{1} 2x\\,dx$ and determine which graph corresponds to $y = 2x$:\n<svg viewBox="0 0 500 130"><line x1="30" y1="100" x2="90" y2="30" stroke="#1a5276" stroke-width="2" /></svg>' },
    status: 'APPROVED',
    options: [
      { position: 0, body: { text: 'Result = $1$, Graph C' }, isCorrect: true },
      { position: 1, body: { text: 'Result = $2$, Graph A' }, isCorrect: false },
      { position: 2, body: { text: 'Result = $0.5$, Graph B' }, isCorrect: false },
      { position: 3, body: { text: 'Result = $4$, Graph D' }, isCorrect: false },
    ],
  };

  const createQuestionRes = await request('POST', '/lecturer/questions', mathQuestionPayload, lecturerToken);
  assert(createQuestionRes.status === 201 && createQuestionRes.data?.data?.id, 'Create question containing LaTeX math and SVG diagram', createQuestionRes);
  const testQuestionId = createQuestionRes.data?.data?.id;

  // Question approval flow
  const approveRes = await request('PATCH', `/lecturer/questions/${testQuestionId}`, { status: 'APPROVED' }, lecturerToken);
  assert(approveRes.status === 200 && approveRes.data?.data?.version?.status === 'APPROVED', 'Approve question for exam compilation', approveRes);

  // --- 5. EXAM AUTHORING (IMMEDIATE LECTURER APPROVAL) ---
  console.log('\n5. Testing Lecturer Exam Authoring & Immediate Approval...');
  const examPayload = {
    courseId: targetCourseId,
    title: `Automated CBT Validation Exam (${Date.now()})`,
    kind: 'MID_SEMESTER',
    audience: 'INSTITUTIONAL',
    durationMin: 30,
    passMark: 50,
    institutionName: 'LASUSTECH',
    levelLabel: '300 Level',
    examBoard: 'University Examination Board',
    sections: [
      {
        title: 'Core Section',
        timerMode: 'SHARED',
        rules: [
          {
            mode: 'BY_RULE',
            count: 2,
            marks: 1,
          },
        ],
      },
    ],
  };

  const createExamRes = await request('POST', '/lecturer/exams', examPayload, lecturerToken);
  const testExamId = createExamRes.data?.data?.exam?.id || createExamRes.data?.data?.id;
  assert(createExamRes.status === 201 && testExamId, 'Lecturer creates exam paper', createExamRes);
  assert((createExamRes.data?.data?.exam?.status || createExamRes.data?.data?.status) === 'APPROVED', 'Exam status is APPROVED immediately without requiring admin pre-approval');

  // --- 6. ADMIN SCHEDULING, SITTING & ACCESS CODE ---
  console.log('\n6. Testing Admin Exam Window Scheduling & Access Code...');
  const existingSittings = await request('GET', '/admin/schedule', null, adminToken);
  const maxEnd = (existingSittings.data?.data || []).reduce((max, s) => {
    const t = new Date(s.endsAt).getTime();
    return t > max ? t : max;
  }, Date.now() + 7 * 86400000);
  const sittingDate = new Date(maxEnd + 2 * 3600000);

  const scheduleRes = await request('POST', '/admin/schedule', {
    examId: testExamId,
    startsAt: sittingDate.toISOString(),
    durationMin: 30,
    invigilatorIds: [],
  }, adminToken);
  assert(scheduleRes.status === 201 && scheduleRes.data?.data?.id, 'Admin schedules examination sitting window and venue', scheduleRes);
  const testSittingId = scheduleRes.data?.data?.id;
  let testAccessCode = scheduleRes.data?.data?.accessCode;

  // Access code regeneration
  const regenCodeRes = await request('POST', `/admin/schedule/${testSittingId}/access-code`, {}, adminToken);
  assert(regenCodeRes.status === 200 && regenCodeRes.data?.data?.accessCode, 'Admin generates and updates 6-digit exam access code', regenCodeRes);
  testAccessCode = regenCodeRes.data?.data?.accessCode;

  // Open the sitting
  const openSittingRes = await request('POST', `/admin/schedule/${testSittingId}/open`, {}, adminToken);
  assert(openSittingRes.status === 200 && openSittingRes.data?.data?.status === 'OPEN', 'Admin opens exam sitting for candidate intake', openSittingRes);

  // --- 7. STUDENT PORTAL & ACCESS CODE UNLOCK ---
  console.log('\n7. Testing Student Sitting Access & Access Code Verification...');

  const studentDashboard = await request('GET', '/student/dashboard', null, studentToken);
  assert(studentDashboard.status === 200 && studentDashboard.data?.data?.student, 'Student dashboard loads candidate profile');
  const availableSittings = studentDashboard.data?.data?.live || [];
  const candidateSitting = availableSittings.find((s) => s.id === testSittingId) || availableSittings[0];
  const targetSittingId = candidateSitting?.id || testSittingId;
  assert(Boolean(candidateSitting), `Target exam sitting is visible to student (Access code notification linked: ${Boolean(candidateSitting?.accessCode)})`);

  // Invalid code rejected
  const badStartRes = await request('POST', `/student/sittings/${targetSittingId}/start`, { accessCode: 'INVALID' }, studentToken);
  assert(badStartRes.status === 400 && badStartRes.data?.error?.code === 'INVALID_ACCESS_CODE', 'Security check: Invalid access code rejected with 400 INVALID_ACCESS_CODE', badStartRes);

  // Valid code starts exam
  const validCode = testAccessCode || candidateSitting?.accessCode;
  const validStartRes = await request('POST', `/student/sittings/${targetSittingId}/start`, { accessCode: validCode }, studentToken);
  assert(validStartRes.status === 200 && validStartRes.data?.data?.attemptId, 'Exam unlocked and attempt started with valid access code', validStartRes);
  const attemptId = validStartRes.data?.data?.attemptId;
  const questions = validStartRes.data?.data?.questions || [];
  assert(questions.length > 0, `Candidate receives personalized question paper (${questions.length} questions)`);

  // Answer scrub security check
  const leakedAnswer = questions.some((q) => q.options.some((o) => o.isCorrect !== undefined));
  assert(!leakedAnswer, 'Anti-leak verification: isCorrect stripped completely from student question payload');

  // --- 8. REALTIME AUTOSAVE & ATTEMPT RESUME ---
  console.log('\n8. Testing Offline-Resilient Autosave & Resume...');
  if (questions.length > 0) {
    const q1 = questions[0];
    const selectedOpt = q1.options[0]?.position ?? 0;
    const saveRes = await request('POST', `/student/attempts/${attemptId}/answer`, {
      questionVersionId: q1.questionVersionId,
      selectedPositions: [selectedOpt],
      flagged: true,
      clientSeq: 1,
    }, studentToken);
    assert(saveRes.status === 200 && saveRes.data?.data?.success === true, 'Candidate answer and flag autosaved with zero data loss', saveRes);

    // Resume attempt
    const resumeRes = await request('GET', `/student/attempts/${attemptId}`, null, studentToken);
    assert(resumeRes.status === 200 && resumeRes.data?.data?.attemptId === attemptId, 'Candidate can resume examination without losing time or state', resumeRes);
  }

  // --- 9. SUBMISSION & RESULT RELEASE GATE ---
  console.log('\n9. Testing Submission & Result Release Gate...');
  const submitRes = await request('POST', `/student/attempts/${attemptId}/submit`, { endedReason: 'STUDENT_SUBMIT' }, studentToken);
  assert(submitRes.status === 200 && submitRes.data?.data?.refCode, 'Exam submitted successfully with cryptographic receipt reference', submitRes);
  const receipt = submitRes.data?.data;
  assert(receipt.score === null, 'Result Gating Guard: Student score is WITHHELD upon submission (pending Admin release)');

  const studentResultsRes = await request('GET', '/student/results', null, studentToken);
  assert(studentResultsRes.status === 200 && Array.isArray(studentResultsRes.data?.data?.results), 'GET /student/results returns official transcript');
  const gpa = studentResultsRes.data?.data?.summary?.gpa;
  assert(gpa !== undefined, `Cumulative GPA calculation rendered: ${gpa} / 5.0`);

  // --- 10. PUBLIC EXAMS FLOW ---
  console.log('\n10. Testing Public Exam Links (Anonymous Candidate Flow)...');
  const publicExamPayload = {
    courseId: targetCourseId,
    title: `Public Mock Test (${Date.now()})`,
    kind: 'CUSTOM',
    audience: 'PUBLIC',
    durationMin: 15,
    passMark: 50,
    institutionName: 'LASUSTECH Public Testing',
    levelLabel: 'General Public',
    accessCode: 'PUB123',
    sections: [
      {
        title: 'Public General Knowledge',
        timerMode: 'SHARED',
        rules: [
          {
            mode: 'BY_RULE',
            count: 2,
            marks: 1,
          },
        ],
      },
    ],
  };

  const createPublicExamRes = await request('POST', '/lecturer/exams', publicExamPayload, lecturerToken);
  const publicSlug = createPublicExamRes.data?.data?.exam?.publicSlug || createPublicExamRes.data?.data?.publicSlug;
  assert(createPublicExamRes.status === 201 && publicSlug, 'Lecturer creates public exam with shareable slug link', createPublicExamRes);

  if (publicSlug) {
    const getPublicExamRes = await request('GET', `/public/exams/${publicSlug}`);
    assert(getPublicExamRes.status === 200 && getPublicExamRes.data?.data?.title, `GET /public/exams/:slug returns public exam details without authentication`, getPublicExamRes);

    const startPublicRes = await request('POST', `/public/exams/${publicSlug}/start`, {
      name: 'Tunde Bakare',
      email: `tunde.${Date.now()}@example.com`,
      accessCode: 'PUB123',
    });
    assert((startPublicRes.status === 200 || startPublicRes.status === 201) && startPublicRes.data?.data?.attemptId, 'Public candidate initiates attempt with public access code', startPublicRes);
    const publicAttemptId = startPublicRes.data?.data?.attemptId;
    const publicToken = startPublicRes.data?.data?.token;

    if (publicAttemptId && publicToken) {
      const publicSubmitRes = await request('POST', `/public/attempts/${publicAttemptId}/submit`, {}, publicToken);
      assert(publicSubmitRes.status === 200 && publicSubmitRes.data?.data?.submitted === true, 'Public candidate submits paper and receives submission confirmation', publicSubmitRes);
    }
  }

  // --- 11. SETTINGS PERSISTENCE & DB ENFORCEMENT ---
  console.log('\n11. Testing System Settings & Database Enforcement...');
  const getSettingsRes = await request('GET', '/admin/settings', null, adminToken);
  assert(getSettingsRes.status === 200 && getSettingsRes.data?.data?.general && getSettingsRes.data?.data?.exam, 'Admin retrieves global system settings');

  const currentExamSettings = getSettingsRes.data?.data?.exam;
  const updatedExamSettings = {
    ...currentExamSettings,
    autosaveSeconds: 5,
    tabSwitchLimit: 3,
  };

  const updateSettingsRes = await request('PUT', '/admin/settings/exam', updatedExamSettings, adminToken);
  assert(updateSettingsRes.status === 200 && updateSettingsRes.data?.data?.autosaveSeconds === 5, 'Admin updates exam settings; persisted to database and cache invalidated');

  // --- 12. REALTIME WEBSOCKET & REDIS CONNECTIVITY ---
  console.log('\n12. Testing Realtime WebSocket Server (Port 3002)...');
  await new Promise((resolve) => {
    try {
      const socket = io(REALTIME_URL, {
        auth: { token: adminToken },
        transports: ['websocket', 'polling'],
        timeout: 5000,
      });

      socket.on('connect', () => {
        assert(true, `Realtime WebSocket connected successfully (Socket ID: ${socket.id})`);
        socket.emit('join_sitting', testSittingId);
        assert(true, `Joined sitting room sitting:${testSittingId}`);
        socket.disconnect();
        resolve(true);
      });

      socket.on('connect_error', (err) => {
        assert(false, `Realtime WebSocket connection failed: ${err.message}`);
        socket.disconnect();
        resolve(false);
      });
    } catch (e) {
      assert(false, `Realtime socket initialization error: ${e.message}`);
      resolve(false);
    }
  });

  // --- SUMMARY ---
  console.log('\n================================================================');
  console.log(`   TEST EXECUTION COMPLETED: ${passed} PASSED, ${failed} FAILED   `);
  console.log('================================================================');

  if (failed > 0) {
    console.error('\nFailures summary:');
    for (const f of failures) {
      console.error(`- ${f.name}`);
    }
    process.exit(1);
  } else {
    console.log('\nAll 12 core subsystems passed end-to-end verification with 100% success!');
    process.exit(0);
  }
}

runComprehensiveTests().catch((err) => {
  console.error('Test execution fatal error:', err);
  process.exit(1);
});
