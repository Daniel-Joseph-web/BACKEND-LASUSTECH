/**
 * Gives the runtime database role a password and points the application at it.
 *
 *   node scripts/provision-app-role.mjs
 *
 * Why this is not in the migration: a password written into a migration file is
 * a secret in version control. The migration creates `cbt_app` with LOGIN but
 * no password; this script (run once per environment, with the owner URL) sets
 * it and rewrites DATABASE_URL in apps/api/.env and apps/worker/.env.
 *
 * Inputs:
 *   ADMIN_DATABASE_URL  owner connection (defaults to packages/db/.env)
 *   APP_DB_PASSWORD     password to set (generated when absent)
 *
 * Nothing secret is printed: the log shows the URL with the password masked.
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const dbRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(dbRoot, '../..');
const LOG = resolve(dbRoot, 'provision-app-role.log');

const out = (text) => {
  process.stdout.write(text);
  appendFileSync(LOG, text, 'utf8');
};

const envValue = (text, key) => {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'));
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, '');
};

function ownerUrl() {
  if (process.env.ADMIN_DATABASE_URL) return process.env.ADMIN_DATABASE_URL;
  const file = resolve(dbRoot, '.env');
  if (!existsSync(file)) return undefined;
  return envValue(readFileSync(file, 'utf8'), 'DATABASE_URL');
}

function rewriteEnv(file, url) {
  if (!existsSync(file)) {
    writeFileSync(file, `DATABASE_URL="${url}"\n`, 'utf8');
    return 'created';
  }
  const text = readFileSync(file, 'utf8');
  const line = `DATABASE_URL="${url}"`;
  if (/^\s*DATABASE_URL\s*=.*$/m.test(text)) {
    writeFileSync(file, text.replace(/^\s*DATABASE_URL\s*=.*$/m, line), 'utf8');
    return 'updated';
  }
  writeFileSync(file, `${text.replace(/\s*$/, '')}\n${line}\n`, 'utf8');
  return 'added';
}

const mask = (url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}${u.search}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
};

async function main() {
  writeFileSync(LOG, `LASUSTECH CBT — provision-app-role — ${new Date().toISOString()}\n\n`, 'utf8');

  const admin = ownerUrl();
  if (!admin) {
    throw new Error(
      'No owner DATABASE_URL. Set ADMIN_DATABASE_URL or create packages/db/.env first.',
    );
  }

  const password =
    process.env.APP_DB_PASSWORD ??
    crypto.randomBytes(32).toString('base64url');

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: admin } } });

  try {
    const [{ exists }] = await prisma.$queryRaw`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbt_app') AS exists`;
    if (!exists) {
      throw new Error(
        'Role cbt_app does not exist. Apply migration 2_identity_hardening first: prisma migrate deploy',
      );
    }

    const escaped = password.replace(/'/g, "''");
    await prisma.$executeRawUnsafe(`ALTER ROLE cbt_app LOGIN PASSWORD '${escaped}'`);

    // Prove the credential works before writing it anywhere.
    const appUrl = new URL(admin);
    appUrl.username = 'cbt_app';
    appUrl.password = password;
    appUrl.search = '?schema=public';
    const check = new PrismaClient({ datasources: { db: { url: appUrl.toString() } } });
    try {
      const [me] = await check.$queryRaw`SELECT current_user AS role`;
      if (me?.role !== 'cbt_app') throw new Error(`Connected as ${me?.role}, expected cbt_app`);
    } finally {
      await check.$disconnect();
    }

    out(`▸ Password set for cbt_app\n`);
    out(`▸ Verified connection as cbt_app\n`);

    for (const rel of ['apps/api/.env', 'apps/worker/.env']) {
      const file = resolve(repoRoot, rel);
      const action = rewriteEnv(file, appUrl.toString());
      out(`▸ ${rel}: DATABASE_URL ${action}\n`);
    }

    out(`\nRuntime URL: ${mask(appUrl.toString())}\n`);
    out('Owner URL (packages/db/.env) is unchanged and still used by migrations/seed.\n');
    out('Restart the API and worker for the new connection to take effect.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`✗ ${message}\n`);
  appendFileSync(LOG, `✗ ${message}\n`, 'utf8');
  process.exit(1);
});
