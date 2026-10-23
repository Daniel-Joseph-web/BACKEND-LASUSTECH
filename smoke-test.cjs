/**
 * Comprehensive Smoke Test for LASUSTECH CBT
 * Tests Lecturer and Admin APIs, Workflow, Question Status Toggle,
 * Bulk Question Approval, Exam Creation, and Admin Timetabling.
 */
const http = require('http');

const API_BASE = 'http://localhost:3001/api/v1';

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + path);
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

async function runSmokeTests() {
  console.log('====================================================');
  console.log('   LASUSTECH CBT API SMOKE TEST (ADMIN & LECTURER)  ');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${name} (status: ${details?.status || 'N/A'}, err: ${JSON.stringify(details?.data || details)})`);
      failed++;
    }
  }

  // 1. AUTHENTICATION
  console.log('1. Testing Authentication...');
  const adminLogin = await request('POST', '/auth/login', {
    identifier: 'admin@lasustech.edu.ng',
    password: 'ChangeMe123!',
  });
  assert(adminLogin.status === 200 && adminLogin.data?.data?.accessToken, 'Admin Login successful');
  const adminToken = adminLogin.data?.data?.accessToken;
  const adminUser = adminLogin.data?.data?.user;
  assert(adminUser?.primaryRole === 'ADMIN', 'Admin primary role verified', adminUser?.primaryRole);

  const lecturerLogin = await request('POST', '/auth/login', {
    identifier: 'bello@lasustech.edu.ng',
    password: 'ChangeMe123!',
  });
  assert(lecturerLogin.status === 200 && lecturerLogin.data?.data?.accessToken, 'Lecturer Login successful');
  const lecturerToken = lecturerLogin.data?.data?.accessToken;
  const lecturerUser = lecturerLogin.data?.data?.user;
  assert(lecturerUser?.roles?.includes('LECTURER') || lecturerUser?.primaryRole === 'LECTURER', 'Lecturer role verified', lecturerUser?.primaryRole);

  // 2. GET /me for both
  console.log('\n2. Testing /me endpoint...');
  const meAdmin = await request('GET', '/me', null, adminToken);
  assert(meAdmin.status === 200 && meAdmin.data?.data?.id, 'Admin /me returns profile');
  const meLecturer = await request('GET', '/me', null, lecturerToken);
  assert(meLecturer.status === 200 && meLecturer.data?.data?.id, 'Lecturer /me returns profile');

  // 2.1 TRIPLE-LEVEL SECURITY CHECKS
  console.log('\n2.1 Testing Triple-Level Security & Role Barrier Guards...');

  // A. Anonymous protection: calls without token return 401
  const anonAdmin = await request('GET', '/admin/dashboard');
  assert(anonAdmin.status === 401, 'Level 1: Anonymous request to /admin/dashboard blocked with 401');

  const anonLecturer = await request('GET', '/lecturer/courses');
  assert(anonLecturer.status === 401, 'Level 1: Anonymous request to /lecturer/courses blocked with 401');

  const anonStudent = await request('GET', '/student/dashboard');
  assert(anonStudent.status === 401, 'Level 1: Anonymous request to /student/dashboard blocked with 401');

  // B. Role segregation: Non-admin accounts cannot access Admin endpoints
  const lecturerHasAdmin = lecturerUser?.roles?.includes('ADMIN');
  const lecturerOnAdmin = await request('GET', '/admin/users', null, lecturerToken);
  assert(
    lecturerHasAdmin ? lecturerOnAdmin.status === 200 : lecturerOnAdmin.status === 403,
    lecturerHasAdmin
      ? 'Level 2: Multi-role staff member holds both Admin + Lecturer privileges'
      : 'Level 2: Lecturer accessing /admin/users blocked with 403'
  );

  // C. Public Auth Endpoints: Verify clearance code
  const validClearance = await request('POST', '/auth/verify', { code: 'LST-2026-CLEAR' });
  assert(validClearance.status === 200 && validClearance.data?.data?.verified === true, 'Level 3: /auth/verify accepts valid clearance code format');

  const invalidClearance = await request('POST', '/auth/verify', { code: 'X' });
  assert(invalidClearance.status === 400 || invalidClearance.status === 422, 'Level 3: /auth/verify rejects malformed clearance code with 400/422');

  // D. Public Auth Endpoints: Password reset request
  const resetReq = await request('POST', '/auth/reset-password', { identifier: 'admin@lasustech.edu.ng' });
  assert(resetReq.status === 200 && resetReq.data?.data?.success === true, 'Level 3: /auth/reset-password completes with standard confirmation');

  // 3. ADMIN API ENDPOINTS
  console.log('\n3. Testing Admin Endpoints...');
  const adminDash = await request('GET', '/admin/dashboard', null, adminToken);
  assert(adminDash.status === 200, 'GET /admin/dashboard', adminDash);

  const adminStructure = await request('GET', '/admin/structure', null, adminToken);
  assert(adminStructure.status === 200 && Array.isArray(adminStructure.data?.data), 'GET /admin/structure (colleges/departments)', adminStructure);

  const adminCourses = await request('GET', '/admin/courses', null, adminToken);
  assert(adminCourses.status === 200 && Array.isArray(adminCourses.data?.data), 'GET /admin/courses', adminCourses);
  const cscCourse = adminCourses.data?.data?.find((c) => c.code === 'CSC 301');
  assert(Boolean(cscCourse), 'Found CSC 301 course in database', adminCourses);

  const adminUsers = await request('GET', '/admin/users', null, adminToken);
  assert(adminUsers.status === 200 && Array.isArray(adminUsers.data?.data), 'GET /admin/users');

  const adminInvigilators = await request('GET', '/admin/invigilators', null, adminToken);
  assert(adminInvigilators.status === 200 && Array.isArray(adminInvigilators.data?.data), 'GET /admin/invigilators');

  const adminSessions = await request('GET', '/admin/sessions', null, adminToken);
  assert(adminSessions.status === 200 && Array.isArray(adminSessions.data?.data), 'GET /admin/sessions');

  const adminSchedule = await request('GET', '/admin/schedule', null, adminToken);
  assert(adminSchedule.status === 200 && Array.isArray(adminSchedule.data?.data), 'GET /admin/schedule');

  // 4. LECTURER API ENDPOINTS & WORKFLOW
  console.log('\n4. Testing Lecturer Endpoints & Question Bank...');
  const lecDash = await request('GET', '/lecturer/dashboard/summary', null, lecturerToken);
  assert(lecDash.status === 200, 'GET /lecturer/dashboard/summary');

  const lecCourses = await request('GET', '/lecturer/courses', null, lecturerToken);
  assert(lecCourses.status === 200 && Array.isArray(lecCourses.data?.data), 'GET /lecturer/courses');
  const assignedCourseId = lecCourses.data?.data?.[0]?.id;
  assert(Boolean(assignedCourseId), 'Lecturer has assigned course', assignedCourseId);

  // Create a Draft Question
  const draftQ = await request('POST', '/lecturer/questions', {
    courseId: assignedCourseId,
    answerFormat: 'MCQ_SINGLE',
    difficulty: 'MEDIUM',
    marks: 2,
    stem: { text: 'Smoke Test Question 1: What is the primary purpose of an operating system kernel?' },
    status: 'DRAFT',
    options: [
      { position: 0, body: { text: 'To manage hardware and system resources' }, isCorrect: true },
      { position: 1, body: { text: 'To compile user programs' }, isCorrect: false },
      { position: 2, body: { text: 'To browse the web' }, isCorrect: false },
    ],
  }, lecturerToken);
  assert(draftQ.status === 201 && draftQ.data?.data?.id, 'Create DRAFT question', draftQ.data?.data?.id);
  const qId = draftQ.data?.data?.id;

  // Toggle status from DRAFT to APPROVED via PATCH /lecturer/questions/:id
  const toggleToApproved = await request('PATCH', `/lecturer/questions/${qId}`, {
    status: 'APPROVED',
  }, lecturerToken);
  assert(toggleToApproved.status === 200 && toggleToApproved.data?.data?.version?.status === 'APPROVED', 'Toggle question from DRAFT to APPROVED');

  // Toggle status back from APPROVED to DRAFT
  const toggleToDraft = await request('PATCH', `/lecturer/questions/${qId}`, {
    status: 'DRAFT',
  }, lecturerToken);
  assert(toggleToDraft.status === 200 && toggleToDraft.data?.data?.version?.status === 'DRAFT', 'Toggle question from APPROVED to DRAFT');

  // Create another draft question to test BULK APPROVE
  const draftQ2 = await request('POST', '/lecturer/questions', {
    courseId: assignedCourseId,
    answerFormat: 'MCQ_SINGLE',
    difficulty: 'EASY',
    marks: 1,
    stem: { text: 'Smoke Test Question 2: Which layer provides process-to-process communication in OSI model?' },
    status: 'DRAFT',
    options: [
      { position: 0, body: { text: 'Transport layer' }, isCorrect: true },
      { position: 1, body: { text: 'Physical layer' }, isCorrect: false },
    ],
  }, lecturerToken);
  assert(draftQ2.status === 201, 'Create second DRAFT question');

  // Test BULK APPROVE endpoint
  const bulkApprove = await request('POST', '/lecturer/questions/bulk-approve', {
    courseId: assignedCourseId,
  }, lecturerToken);
  assert(bulkApprove.status === 200 && bulkApprove.data?.data?.count >= 2, 'POST /lecturer/questions/bulk-approve approves all drafts', bulkApprove.data?.data);

  // Check available question counts for exam building
  const availableCounts = await request('GET', `/lecturer/questions/available?courseId=${assignedCourseId}`, null, lecturerToken);
  assert(availableCounts.status === 200 && Array.isArray(availableCounts.data?.data), 'GET /lecturer/questions/available', availableCounts.data?.data);
  const totalApproved = availableCounts.data?.data?.reduce((sum, r) => sum + r._count.id, 0) || 0;
  console.log(`    -> Available approved questions for course: ${totalApproved}`);

  // 5. EXAM CREATION WORKFLOW (Approved immediately, no artificial gate)
  console.log('\n5. Testing Lecturer Exam Creation...');
  const examRes = await request('POST', '/lecturer/exams', {
    courseId: assignedCourseId,
    title: 'CSC 301 Mid-Semester CBT Examination',
    kind: 'MID_SEMESTER',
    audience: 'INSTITUTIONAL',
    durationMin: 45,
    passMark: 50,
    institutionName: 'LASUSTECH',
    levelLabel: '300 Level',
    examBoard: 'University Examination Board',
    sections: [
      {
        title: 'Section A - Theory & Architecture',
        timerMode: 'SHARED',
        rules: [
          {
            mode: 'BY_RULE',
            count: Math.min(2, totalApproved),
            marks: 1,
          },
        ],
      },
    ],
  }, lecturerToken);
  assert(examRes.status === 201 && examRes.data?.data?.exam?.id, 'Create & publish exam (Immediately APPROVED)', examRes.data?.data?.exam?.title);
  const examId = examRes.data?.data?.exam?.id;
  assert(examRes.data?.data?.exam?.status === 'APPROVED', 'Exam status is APPROVED immediately');

  // 6. ADMIN SCHEDULING (Exam immediately visible in Schedulable Exams)
  console.log('\n6. Testing Admin Exam Scheduling...');
  const schedulableExams = await request('GET', '/admin/exams', null, adminToken);
  assert(schedulableExams.status === 200, 'GET /admin/exams (schedulable exams)', schedulableExams);
  const foundExam = schedulableExams.data?.data?.find((e) => e.id === examId);
  assert(Boolean(foundExam), 'New lecturer exam appears in Admin schedulable exams list', schedulableExams);

  // Admin schedules the exam (pick a unique future slot)
  const existingSittings = await request('GET', '/admin/schedule', null, adminToken);
  const maxEnd = (existingSittings.data?.data || []).reduce((max, s) => {
    const t = new Date(s.endsAt).getTime();
    return t > max ? t : max;
  }, Date.now() + 7 * 86400000);

  const sittingDate = new Date(maxEnd + 2 * 3600000);

  const sittingRes = await request('POST', '/admin/schedule', {
    examId,
    startsAt: sittingDate.toISOString(),
    durationMin: 45,
    invigilatorIds: [],
  }, adminToken);
  assert(sittingRes.status === 201 && sittingRes.data?.data?.id, 'Admin schedules exam sitting successfully', sittingRes);
  const sittingId = sittingRes.data?.data?.id;
  let generatedAccessCode = sittingRes.data?.data?.accessCode;

  if (sittingId) {
    // Generate new access code
    const codeRes = await request('POST', `/admin/schedule/${sittingId}/access-code`, {}, adminToken);
    assert(codeRes.status === 200 && codeRes.data?.data?.accessCode, 'Generate sitting access code', codeRes);
    generatedAccessCode = codeRes.data?.data?.accessCode;

    // Open the sitting
    const openRes = await request('POST', `/admin/schedule/${sittingId}/open`, {}, adminToken);
    assert(openRes.status === 200 && openRes.data?.data?.status === 'OPEN', 'Open sitting for students', openRes);
  } else {
    console.error('Sitting ID is missing, sitting response was:', JSON.stringify(sittingRes));
  }

  // 7. STUDENT PORTAL & CBT EXAMINATION FLOW
  console.log('\n7. Testing Student Portal & CBT Examination Flow...');

  // 7.0 Flush lingering sessions to clear any prior abandoned attempts
  await request('POST', '/admin/settings/flush-sessions', { force: true }, adminToken);

  // 7.1 Student Login
  const studentLoginRes = await request('POST', '/auth/login', {
    identifier: 'nifemi@cbt.lasustech.edu.ng',
    password: 'ChangeMe123!',
    portal: 'student',
  });
  const studentToken = studentLoginRes.data?.data?.accessToken;

  // E. Role segregation: Student cannot access Admin or Lecturer endpoints (returns 403)
  const studentOnAdmin = await request('GET', '/admin/dashboard', null, studentToken);
  assert(studentOnAdmin.status === 403, 'Level 2: Student accessing /admin/dashboard blocked with 403');

  const studentOnLecturer = await request('GET', '/lecturer/courses', null, studentToken);
  assert(studentOnLecturer.status === 403, 'Level 2: Student accessing /lecturer/courses blocked with 403');

  // 7.2 Student Dashboard
  const studentDashRes = await request('GET', '/student/dashboard', null, studentToken);
  assert(studentDashRes.status === 200 && studentDashRes.data?.data?.student, 'GET /student/dashboard returns candidate profile');
  const studentProfile = studentDashRes.data?.data?.student;
  assert(studentProfile?.matricNo && studentProfile?.names === 'Nifemi Osadare', 'Candidate profile matches matric & name', studentProfile);
  const liveExams = studentDashRes.data?.data?.live || [];
  assert(liveExams.length > 0, `Live examination available on dashboard (${liveExams.length} active sitting(s))`);

  const activeSitting = liveExams[0];
  const targetSittingId = activeSitting?.id || sittingId;

  // 7.3 Sitting Pre-check Details
  const sittingDetailsRes = await request('GET', `/student/sittings/${targetSittingId}`, null, studentToken);
  assert(sittingDetailsRes.status === 200 && sittingDetailsRes.data?.data?.sitting, 'GET /student/sittings/:id returns verified candidate & paper specs');
  assert(sittingDetailsRes.data?.data?.candidate?.verified === true, 'Candidate identity is verified for CBT');

  // 7.4 Test Security: Invalid access code is strictly rejected
  const badAttemptRes = await request('POST', `/student/sittings/${targetSittingId}/start`, {
    accessCode: 'WRONG9',
  }, studentToken);
  assert(badAttemptRes.status === 400 && badAttemptRes.data?.error?.code === 'INVALID_ACCESS_CODE', 'Security check: Invalid access code is strictly rejected with 400 INVALID_ACCESS_CODE', badAttemptRes);

  // 7.4b Start Attempt with Valid Access Code
  const finalCode = generatedAccessCode || activeSitting?.accessCode;
  const startAttemptRes = await request('POST', `/student/sittings/${targetSittingId}/start`, {
    accessCode: finalCode,
  }, studentToken);
  assert(startAttemptRes.status === 200 && startAttemptRes.data?.data?.attemptId, 'POST /student/sittings/:id/start begins examination session with valid access code', startAttemptRes);
  const studentAttemptId = startAttemptRes.data?.data?.attemptId;
  const paperQuestions = startAttemptRes.data?.data?.questions || [];
  assert(paperQuestions.length > 0, `Candidate receives personalized question paper (${paperQuestions.length} questions)`);

  // Verify questions do NOT leak correct answers
  const hasLeakedAnswers = paperQuestions.some((q) => q.options.some((opt) => opt.isCorrect !== undefined));
  assert(!hasLeakedAnswers, 'Security check: Correct answers and explanations are scrubbed from candidate paper');

  // 7.5 Resume / Get Attempt Paper
  const getAttemptRes = await request('GET', `/student/attempts/${studentAttemptId}`, null, studentToken);
  assert(getAttemptRes.status === 200 && getAttemptRes.data?.data?.attemptId === studentAttemptId, 'GET /student/attempts/:id resumes attempt session');

  // 7.6 Real-time Autosave Answer
  if (paperQuestions.length > 0) {
    const q1 = paperQuestions[0];
    const selectedOpt = q1.options[0]?.position ?? 0;
    const saveAnswerRes = await request('POST', `/student/attempts/${studentAttemptId}/answer`, {
      questionVersionId: q1.questionVersionId,
      selectedPositions: [selectedOpt],
      flagged: true,
      clientSeq: 1,
    }, studentToken);
    assert(saveAnswerRes.status === 200 && saveAnswerRes.data?.data?.success === true, 'POST /student/attempts/:id/answer saves answer & flag in real time');
  }

  // 7.7 Finalize & Submit Attempt
  const submitAttemptRes = await request('POST', `/student/attempts/${studentAttemptId}/submit`, {
    endedReason: 'STUDENT_SUBMIT',
  }, studentToken);
  assert(submitAttemptRes.status === 200 && submitAttemptRes.data?.data?.refCode, 'POST /student/attempts/:id/submit finalizes attempt and generates receipt slip');
  const receipt = submitAttemptRes.data?.data;
  assert(Boolean(receipt?.refCode?.startsWith('LASU-')), `Receipt reference generated: ${receipt?.refCode}`);
  assert(
    receipt?.refCode && (receipt?.score?.percent !== undefined || receipt?.score === null),
    `Submission finalized: ${receipt?.refCode} (${receipt?.score?.percent !== undefined ? `Score: ${receipt.score.percent}%` : 'Result held pending admin release'})`
  );

  // 7.8 Academic Results & Transcript
  const resultsRes = await request('GET', '/student/results', null, studentToken);
  assert(resultsRes.status === 200 && resultsRes.data?.data?.results, 'GET /student/results fetches official academic grades');
  const resultsData = resultsRes.data?.data;
  assert(resultsData.results.length > 0, `Student transcript contains ${resultsData.results.length} course assessment(s)`);
  assert(Boolean(resultsData.summary?.gpa), `GPA calculation displayed: ${resultsData.summary?.gpa} / 5.0`);

  // Clean close sitting if needed
  if (sittingId) {
    await request('POST', `/admin/schedule/${sittingId}/close`, {}, adminToken);
  }

  console.log('\n====================================================');
  console.log(`SMOKE TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSmokeTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
