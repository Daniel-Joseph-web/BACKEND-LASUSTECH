/**
 * Moves the development database onto the verified baseline without deleting
 * anything.
 *
 *   node scripts/archive-and-rebuild-dev.mjs
 *
 * Steps:
 *   1. starts Postgres if needed and waits for it;
 *   2. terminates connections to `lasustech_cbt` (the API must not be running);
 *   3. renames it to `lasustech_cbt_legacy_<date>` — the old data stays fully
 *      queryable in that database;
 *   4. creates a new empty `lasustech_cbt`;
 *   5. applies every migration (0_init, 1_integrity, 2_identity_hardening),
 *      seeds it, and runs verify-db.ts;
 *   6. gives the least-privilege runtime role cbt_app a password and points
 *      apps/api and apps/worker at it (the API refuses to boot as a superuser).
 *
 * The archive name is never reused: if it already exists, a time suffix is
 * added, so running this twice cannot overwrite the first archive.
 *
 * Everything is logged to packages/db/archive-rebuild.log.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(dbRoot, '../..');
const CONTAINER = 'infra-postgres-1';
const LIVE_DB = 'lasustech_cbt';
const PRISMA = resolve(dbRoot, 'node_modules/prisma/build/index.js');
const SCHEMA = resolve(dbRoot, 'prisma/schema.prisma');
const TS_NODE_REGISTER = resolve(repoRoot, 'node_modules/ts-node/register/transpile-only.js');
const LOG = resolve(dbRoot, 'archive-rebuild.log');

writeFileSync(LOG, `LASUSTECH CBT — archive-and-rebuild-dev — ${new Date().toISOString()}\n`, 'utf8');
const out = (text) => {
  process.stdout.write(text);
  appendFileSync(LOG, text, 'utf8');
};
const err = (text) => {
  process.stderr.write(text);
  appendFileSync(LOG, text, 'utf8');
};

const urlFor = (name) => `postgresql://cbt_user:cbt_password@localhost:5432/${name}?schema=public`;
const liveUrl = urlFor(LIVE_DB);

function run(label, command, args, { env = { ...process.env, DATABASE_URL: liveUrl } } = {}) {
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
  if (result.status !== 0) {
    if (result.stdout) err(result.stdout);
    if (result.stderr) err(result.stderr);
    err(`✗ ${label} exited ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
  if (result.stdout) out(result.stdout);
  if (result.stderr) err(result.stderr);
  return result.stdout ?? '';
}

/** Runs one or more SQL statements against the maintenance database. */
const psql = (label, ...statements) =>
  run(label, 'docker', [
    'exec', CONTAINER, 'psql', '-U', 'cbt_user', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-tAc', statements.join('; '),
  ]);

const stamp = new Date()
  .toISOString()
  .slice(0, 10)
  .replace(/-/g, '');

run('Start Postgres', 'docker', ['start', CONTAINER], { env: process.env });

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

// Only now can the archive name be checked: the query needs a live server.
let archive = `${LIVE_DB}_legacy_${stamp}`;
const existing = psql('Check archive name', `SELECT 1 FROM pg_database WHERE datname = '${archive}'`).trim();
if (existing === '1') {
  const time = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  archive = `${LIVE_DB}_legacy_${stamp}_${time}`;
}

psql(
  'Disconnect clients from the live database',
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${LIVE_DB}' AND pid <> pg_backend_pid()`,
);

psql(
  `Archive ${LIVE_DB} as ${archive}`,
  `ALTER DATABASE "${LIVE_DB}" RENAME TO "${archive}"`,
);

psql(`Create a fresh ${LIVE_DB}`, `CREATE DATABASE "${LIVE_DB}"`);

run('Apply migrations', process.execPath, [PRISMA, 'migrate', 'deploy', '--schema', SCHEMA]);
run('Seed', process.execPath, ['-r', TS_NODE_REGISTER, resolve(dbRoot, 'src/seed.ts')]);
run('Verify', process.execPath, ['-r', TS_NODE_REGISTER, resolve(dbRoot, 'verify-db.ts')]);
run(
  'Provision the runtime role',
  process.execPath,
  [resolve(dbRoot, 'scripts/provision-app-role.mjs')],
  { env: { ...process.env, ADMIN_DATABASE_URL: liveUrl } },
);

out(`\nDevelopment database rebuilt on the verified baseline.\n`);
out(`Archive kept as: ${archive}\n`);
out(`  Inspect it with: docker exec -it ${CONTAINER} psql -U cbt_user -d ${archive}\n`);
out(`Full log: ${LOG}\n`);
