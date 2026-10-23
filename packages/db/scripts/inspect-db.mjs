/**
 * Read-only inspection of whatever database packages/db/.env points at.
 *
 *   node scripts/inspect-db.mjs
 *
 * Writes to packages/db/inspect-db.log. Nothing here writes to the database.
 *
 * It answers the question before any destructive step: is the development
 * database (a) empty, (b) only seed data, or (c) carrying real work that a
 * reset would destroy?
 */
import { PrismaClient } from '@prisma/client';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LOG = resolve(here, '../inspect-db.log');

writeFileSync(LOG, `LASUSTECH CBT — database inspection — ${new Date().toISOString()}\n`, 'utf8');
const say = (text) => {
  process.stdout.write(text);
  appendFileSync(LOG, text, 'utf8');
};

const prisma = new PrismaClient();

const maskedUrl = (process.env.DATABASE_URL ?? 'postgresql://…').replace(
  /:\/\/([^:]+):[^@]*@/,
  '://$1:***@',
);

say(`DATABASE_URL: ${maskedUrl}\n\n`);

const tables = await prisma.$queryRawUnsafe(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name
`);
const names = tables.map((t) => t.table_name);
const has = (name) => names.includes(name);

say(`Tables: ${names.length}\n`);
say(`  colleges present: ${has('colleges')}\n`);
say(`  faculties present (old shape): ${has('faculties')}\n`);
say(`  venues present: ${has('venues')}\n`);
say(`  grade_bands present: ${has('grade_bands')}\n`);
say(`  password_history present: ${has('password_history')}\n`);
say(`  notifications present: ${has('notifications')}\n\n`);

if (has('users')) {
  const columns = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    ORDER BY ordinal_position
  `);
  const cols = columns.map((c) => c.column_name);
  say(`users columns: ${cols.join(', ')}\n`);
  say(`  password_set_at present: ${cols.includes('password_set_at')}\n\n`);
}

// Migration history
if (has('_prisma_migrations')) {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
    FROM _prisma_migrations ORDER BY started_at
  `);
  say(`_prisma_migrations: ${rows.length} row(s)\n`);
  for (const r of rows) {
    say(`  ${r.migration_name} — finished=${r.finished} rolledBack=${r.rolled_back}\n`);
  }
  say('\n');
} else {
  say('_prisma_migrations: table does not exist (database was pushed, not migrated)\n\n');
}

// Row counts for tables that signal real work. A fresh seed has users/courses
// but no exams, attempts, questions or results.
const COUNT_TABLES = [
  'users', 'colleges', 'faculties', 'departments', 'programmes', 'courses',
  'enrollments', 'course_assignments', 'roles', 'user_roles',
  'academic_sessions', 'semesters', 'grade_bands',
  'exams', 'exam_sections', 'exam_questions', 'questions', 'question_versions',
  'sittings', 'attempts', 'attempt_questions', 'answers', 'answer_events',
  'results', 'result_batches', 'appeals', 'audit_logs', 'import_jobs',
  'notifications', 'media_assets',
];

say('Row counts:\n');
for (const table of COUNT_TABLES) {
  if (!has(table)) continue;
  try {
    const [row] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`);
    say(`  ${table.padEnd(20)} ${row.n}\n`);
  } catch (error) {
    say(`  ${table.padEnd(20)} (could not count: ${error.message.split('\n')[0]})\n`);
  }
}

say('\nInterpretation:\n');
say('  * No exams/questions/attempts/results → the database holds only seed data;\n');
say('    a reset is safe and rebuilds it from the verified baseline.\n');
say('  * Any of those present → real work exists; do not reset without backing up.\n');

await prisma.$disconnect();
say(`\nLog: ${LOG}\n`);
