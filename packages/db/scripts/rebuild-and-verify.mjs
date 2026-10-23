/**
 * End-to-end proof that the migrations, the integrity layer and the seed all
 * work — on a throwaway database, so the development database is never touched.
 *
 *   node scripts/rebuild-and-verify.mjs
 *
 * What it does, in order:
 *   1. regenerates 0_init/migration.sql from the schema (UTF-8, no BOM);
 *   2. starts the Postgres container if it is not running;
 *   3. drops and recreates `lasustech_cbt_verify`;
 *   4. `prisma migrate deploy` — 0_init, 1_integrity, 2_identity_hardening;
 *   5. seeds it;
 *   6. `verify-db.ts` — schema, integrity layer, seed coherence, constraint
 *      probes, and the identity/least-privilege probes;
 *   7. re-runs `migrate deploy` and the seed to prove both are idempotent;
 *   8. `verify-db.ts` again, so the second run proves nothing drifted.
 *
 * Everything is also written to packages/db/verify-run.log so the full output
 * survives a terminal that only shows the last screen.
 *
 * Exit code 0 means every step passed.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(dbRoot, '../..');
const CONTAINER = 'infra-postgres-1';
const VERIFY_DB = 'lasustech_cbt_verify';
const SCHEMA = resolve(dbRoot, 'prisma/schema.prisma');
const INIT_SQL = resolve(dbRoot, 'prisma/migrations/0_init/migration.sql');
const PRISMA = resolve(dbRoot, 'node_modules/prisma/build/index.js');
const TS_NODE_REGISTER = resolve(repoRoot, 'node_modules/ts-node/register/transpile-only.js');
const LOG = resolve(dbRoot, 'verify-run.log');

writeFileSync(LOG, `LASUSTECH CBT — rebuild-and-verify — ${new Date().toISOString()}\n`, 'utf8');

const out = (text) => {
  process.stdout.write(text);
  appendFileSync(LOG, text, 'utf8');
};
const err = (text) => {
  process.stderr.write(text);
  appendFileSync(LOG, text, 'utf8');
};

const databaseUrl = (name) =>
  `postgresql://cbt_user:cbt_password@localhost:5432/${name}?schema=public`;
const verifyUrl = databaseUrl(VERIFY_DB);

const BASE_ENV = { ...process.env, DATABASE_URL: verifyUrl };

function run(label, command, args, { env = BASE_ENV, allowFail = false } = {}) {
  out(`\n▸ ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: dbRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    err(`✗ ${label} could not start: ${String(result.error)}\n`);
    process.exit(1);
  }
  if (result.status !== 0 && !allowFail) {
    if (result.stdout) err(result.stdout);
    if (result.stderr) err(result.stderr);
    err(`✗ ${label} exited ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
  if (result.stdout) out(result.stdout);
  if (result.stderr) err(result.stderr);
  return result;
}

// ---------------------------------------------------------------------------

for (const [what, path] of [
  ['Prisma CLI', PRISMA],
  ['ts-node', TS_NODE_REGISTER],
]) {
  if (!existsSync(path)) {
    err(`✗ ${what} not found at ${path}. Run pnpm install first.\n`);
    process.exit(1);
  }
}

// Always regenerate first. A stale or UTF-16 migration.sql is the failure this
// harness exists to catch, so it must never be possible to run the rest without
// rebuilding it.
run('Regenerate 0_init from the schema', process.execPath, [resolve(dbRoot, 'scripts/regen-init.mjs')]);

const initSql = readFileSync(INIT_SQL);
if (initSql.includes(0)) {
  err(
    `\n✗ ${INIT_SQL} still contains NUL bytes — regeneration did not produce UTF-8.\n` +
      '  Refusing to apply it; Postgres would fail with P3018 "embedded null".\n',
  );
  process.exit(1);
}
out(`0_init is UTF-8 (${initSql.length.toLocaleString()} bytes, no NULs)\n`);

// The seed and verify-db.ts run on @prisma/client, not on the schema. If the
// client predates a field (passwordSetAt was the first such case), every write
// through it fails with "Unknown argument" even though the database is correct.
run('Generate the Prisma client', process.execPath, [PRISMA, 'generate', '--schema', SCHEMA]);

run('Start Postgres', 'docker', ['start', CONTAINER], { allowFail: true });

out('\n▸ Wait for Postgres to accept connections\n');
let ready = false;
for (let attempt = 1; attempt <= 30; attempt++) {
  const ping = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'cbt_user', '-d', 'postgres'], {
    encoding: 'utf8',
  });
  if (ping.status === 0) {
    ready = true;
    break;
  }
  spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1000)']);
}
if (!ready) {
  err(`✗ Postgres in ${CONTAINER} did not become ready.\n`);
  process.exit(1);
}
out('  ready\n');

run('Recreate the verification database', 'docker', [
  'exec', CONTAINER, 'psql', '-U', 'cbt_user', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
  '-c', `DROP DATABASE IF EXISTS ${VERIFY_DB} WITH (FORCE)`,
  '-c', `CREATE DATABASE ${VERIFY_DB}`,
]);

run('Apply migrations (first run)', process.execPath, [PRISMA, 'migrate', 'deploy', '--schema', SCHEMA]);
run('Seed (first run)', process.execPath, [
  '-r', TS_NODE_REGISTER, resolve(dbRoot, 'src/seed.ts'),
]);
run('Verify (after first run)', process.execPath, [
  '-r', TS_NODE_REGISTER, resolve(dbRoot, 'verify-db.ts'),
]);

run('Apply migrations again (idempotence)', process.execPath, [PRISMA, 'migrate', 'deploy', '--schema', SCHEMA]);
run('Seed again (idempotence)', process.execPath, [
  '-r', TS_NODE_REGISTER, resolve(dbRoot, 'src/seed.ts'),
]);
run('Verify (after second run)', process.execPath, [
  '-r', TS_NODE_REGISTER, resolve(dbRoot, 'verify-db.ts'),
]);

out(`\nAll database checks passed on ${VERIFY_DB}.\n`);
out(`Connection string used: ${verifyUrl}\n`);
out(`Full log: ${LOG}\n`);
