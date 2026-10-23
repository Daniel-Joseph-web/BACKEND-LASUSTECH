const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, staffId: true, matricNo: true, names: true, roles: { select: { role: { select: { key: true } } } } }
  });
  const exams = await prisma.exam.findMany({
    select: { id: true, title: true, status: true, audience: true, courseId: true, subjectId: true, sessionId: true, _count: { select: { sections: true, sittings: true } } }
  });
  const questions = await prisma.question.findMany({
    select: { id: true, courseId: true, subjectId: true, currentVersion: { select: { id: true, status: true, marks: true, difficulty: true } } }
  });
  const sessions = await prisma.academicSession.findMany();
  console.log('USERS:', JSON.stringify(users, null, 2));
  console.log('EXAMS:', JSON.stringify(exams, null, 2));
  console.log('QUESTIONS:', JSON.stringify(questions, null, 2));
  console.log('SESSIONS:', JSON.stringify(sessions, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
