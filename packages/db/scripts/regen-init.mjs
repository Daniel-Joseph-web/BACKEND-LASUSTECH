/**
 * Regenerates prisma/migrations/0_init/migration.sql from prisma/schema.prisma.
 *
 *   node scripts/regen-init.mjs
 *
 * Why this exists: the previous 0_init was produced by redirecting the Prisma
 * CLI through PowerShell, which wrote UTF-16-LE. Prisma reads migrations as
 * UTF-8, so that file can never be applied. Running the CLI from Node and
 * writing the buffer ourselves guarantees UTF-8 with no BOM, on every platform.
 *
 * It uses `migrate diff --from-empty --to-schema-datamodel`, which is offline
 * (no database needed) and deterministic for a given schema.
 *
 * The hand-written integrity layer lives separately in 1_integrity and is not
 * touched here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = resolve(here, '..');
const schemaPath = resolve(dbRoot, 'prisma/schema.prisma');
const outPath = resolve(dbRoot, 'prisma/migrations/0_init/migration.sql');
const prismaCli = resolve(dbRoot, 'node_modules/prisma/build/index.js');

for (const [label, path] of [
  ['schema', schemaPath],
  ['Prisma CLI', prismaCli],
]) {
  if (!existsSync(path)) {
    console.error(`Cannot find ${label} at ${path}`);
    process.exit(1);
  }
}

const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    schemaPath,
    '--script',
  ],
  { cwd: dbRoot, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 },
);

if (result.error) {
  console.error('Failed to start Prisma:', result.error);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('Prisma exited with', result.status);
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

let sql = result.stdout.replace(/^﻿/, '').replace(/\r\n/g, '\n');

// Sanity-check that we generated the schema, not an empty diff or an error page.
for (const marker of ['CREATE TABLE "users"', 'CREATE TYPE "UserStatus"', 'CREATE TABLE "audit_logs"']) {
  if (!sql.includes(marker)) {
    console.error(`Generated SQL is missing ${marker}; refusing to overwrite 0_init.`);
    process.exit(1);
  }
}

// Prisma creates the citext extension only when the schema declares it through
// the postgresqlExtensions feature; the native type alone may not emit it.
// 1_integrity also creates it, but 0_init must be self-sufficient.
if (!/CREATE EXTENSION IF NOT EXISTS "?citext"?/i.test(sql)) {
  sql = `-- CreateExtension\nCREATE EXTENSION IF NOT EXISTS "citext";\n\n${sql}`;
}

writeFileSync(outPath, sql, 'utf8');
console.log(`Wrote ${sql.length.toLocaleString()} bytes (UTF-8) to ${outPath}`);
