const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function check() {
  try {
    const u = await prisma.user.count();
    const c = await prisma.course.count();
    const e = await prisma.exam.count();
    const q = await prisma.question.count();
    const s = await prisma.academicSession.count();
    console.log(JSON.stringify({ users: u, courses: c, exams: e, questions: q, sessions: s }));
  } catch (err) {
    console.error('Error connecting to database:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}
check();
