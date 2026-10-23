import type { Tx } from './audit';
import type { RoleKey } from '../modules/auth/tokens';

/**
 * Changes a person's roles through the database's own gatekeeper.
 *
 * The runtime database role (`cbt_app`) has no INSERT/UPDATE/DELETE privilege
 * on `user_roles`, `roles`, `role_permissions` or `user_permissions`. The only
 * write path is `app_set_roles()`, a SECURITY DEFINER function that:
 *
 *   * resolves the actor from a *live* auth session, not from a caller-supplied
 *     user id;
 *   * re-checks that the actor holds ADMIN in the database;
 *   * refuses self-role changes (no self-escalation);
 *   * refuses to remove the last active administrator;
 *   * accepts only ADMIN, LECTURER and STUDENT, GLOBAL scope;
 *   * revokes every session of the target, so a new role takes effect at once;
 *   * writes an append-only row to `role_change_log`.
 *
 * Passing the session id (rather than the user id) means even a leaked
 * database password is not enough: the caller must also hold a live session.
 */
export async function setUserRoles(
  tx: Tx,
  actorSessionId: string,
  targetUserId: string,
  roles: readonly RoleKey[],
  requestId = 'api',
): Promise<void> {
  const unique = [...new Set(roles)];
  if (!unique.length) throw new Error('setUserRoles: at least one role is required');

  await tx.$queryRaw`
    SELECT app_set_roles(
      ${actorSessionId}::uuid,
      ${targetUserId}::uuid,
      string_to_array(${unique.join(',')}, ','),
      'GLOBAL'::"ScopeType",
      NULL::uuid,
      ${requestId}::text
    )`;
}
