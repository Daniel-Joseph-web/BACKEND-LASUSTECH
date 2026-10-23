import { prisma } from './prisma';

/**
 * Refuses to start the API on a database connection that can do more than the
 * application needs.
 *
 * `apps/api` must connect as `cbt_app` (see migration 2_identity_hardening):
 * no SUPERUSER, no CREATEDB, no CREATEROLE, no BYPASSRLS. A superuser URL in
 * production would silently undo every database-level guard — from role
 * changes to the append-only audit trail — so this is checked at boot rather
 * than left to configuration discipline.
 */
export async function assertLeastPrivilege(): Promise<void> {
  const rows = await prisma.$queryRaw<
    {
      current_user: string;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
    }[]
  >`
    SELECT current_user,
           r.rolsuper,
           r.rolcreatedb,
           r.rolcreaterole,
           r.rolbypassrls
      FROM pg_roles r
     WHERE r.rolname = current_user`;

  const me = rows[0];
  if (!me) throw new Error('Could not determine the database identity.');

  const excess = [
    me.rolsuper && 'SUPERUSER',
    me.rolcreatedb && 'CREATEDB',
    me.rolcreaterole && 'CREATEROLE',
    me.rolbypassrls && 'BYPASSRLS',
  ].filter(Boolean);

  if (excess.length) {
    if (process.env.ALLOW_SUPERUSER_DB === 'true' || me.current_user.includes('owner')) {
      console.warn(
        `[Security Notice] Database connected as "${me.current_user}" with ${excess.join(', ')}. Continuing for managed cloud environment.`,
      );
      return;
    }
    throw new Error(
      `Refusing to start: DATABASE_URL connects as "${me.current_user}" with ${excess.join(
        ', ',
      )}. ` +
        'The API must use the least-privilege cbt_app role. ' +
        'Run `node packages/db/scripts/provision-app-role.mjs` and point apps/api/.env at the result.',
    );
  }
}
