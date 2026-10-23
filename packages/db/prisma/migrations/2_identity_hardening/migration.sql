-- Identity hardening: three roles, one guarded write path, least privilege.
--
-- The application no longer connects as the database owner. It connects as
-- `cbt_app`, a NOLOGIN/NOSUPERUSER role that can read and write ordinary data
-- but cannot change identity, DDL, or the audit trail. Role changes are only
-- possible through `app_set_roles()`, a SECURITY DEFINER function that proves
-- the actor is an administrator from a live session and refuses self-escalation.
--
-- Hand-written like 1_integrity: `prisma migrate dev` will propose dropping
-- these objects on the next diff. Do not let it.

-- ==========================================
-- 1. RUNTIME ROLE
-- ==========================================
--
-- LOGIN is granted, but no password is set here: a password in a migration file
-- would be a secret in version control. `scripts/provision-app-role.mjs` sets
-- one out of band (APP_DB_PASSWORD), and only that provisioned role is used by
-- apps/api and apps/worker. The migration/owner connection (cbt_user) keeps
-- running schema changes, the seed and verification.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cbt_app') THEN
    CREATE ROLE cbt_app LOGIN;
  END IF;
END
$$;

-- Re-assert the attributes even if the role pre-existed.
ALTER ROLE cbt_app
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT;

-- Bound what a compromised application connection can do to the cluster.
ALTER ROLE cbt_app SET statement_timeout = '15s';
ALTER ROLE cbt_app SET lock_timeout = '5s';
ALTER ROLE cbt_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE cbt_app SET search_path = public, pg_temp;

-- ==========================================
-- 2. DATABASE / SCHEMA PRIVILEGES
-- ==========================================

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO cbt_app', current_database());
END
$$;

-- PUBLIC must not be able to create objects in `public` (a classic route to
-- shadowing a function and having a SECURITY DEFINER caller execute it).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO cbt_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cbt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cbt_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cbt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO cbt_app;

-- The runtime role never replays, edits or clears migrations.
REVOKE ALL ON TABLE "_prisma_migrations" FROM cbt_app;

-- ==========================================
-- 3. IDENTITY TABLES ARE READ-ONLY TO THE APP
-- ==========================================
--
-- Role and permission grants are not ordinary data: they are the authority
-- boundary. The application may read them (login, /me, RBAC) but every write
-- goes through app_set_roles() below.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE roles, role_permissions, user_roles, user_permissions
  FROM cbt_app;

-- The audit trail is append-only for everyone, and the runtime role cannot even
-- attempt an UPDATE/DELETE/TRUNCATE: the trigger remains as a second layer.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM cbt_app;

-- ==========================================
-- 4. DATABASE-OWNED ROLE-CHANGE LOG
-- ==========================================
--
-- The API already writes a hash-chained audit entry. This table is the
-- database's own record, written inside the privileged function, so a
-- compromised application cannot grant a role without leaving a trace here.

CREATE TABLE role_change_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz(3) NOT NULL DEFAULT now(),
  actor_id   uuid   NOT NULL,
  actor_role text   NOT NULL DEFAULT 'ADMIN',
  target_id  uuid   NOT NULL,
  before     text[] NOT NULL,
  after      text[] NOT NULL,
  session_id uuid   NOT NULL,
  request_id text   NOT NULL,
  FOREIGN KEY (actor_id)  REFERENCES users (id),
  FOREIGN KEY (target_id) REFERENCES users (id)
);

CREATE INDEX role_change_log_target_idx ON role_change_log (target_id, at DESC);
CREATE INDEX role_change_log_actor_idx  ON role_change_log (actor_id, at DESC);

CREATE OR REPLACE FUNCTION role_change_log_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'role_change_log is append-only: % rejected', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER role_change_log_immutable
  BEFORE UPDATE OR DELETE ON role_change_log
  FOR EACH ROW EXECUTE FUNCTION role_change_log_reject_mutation();

CREATE TRIGGER role_change_log_immutable_truncate
  BEFORE TRUNCATE ON role_change_log
  FOR EACH STATEMENT EXECUTE FUNCTION role_change_log_reject_mutation();

-- No app privilege at all: the log is the database's own evidence, not data the
-- application reads or writes. (The blanket/default grants above would otherwise
-- leave SELECT, since this table is created after them.)
REVOKE ALL ON TABLE role_change_log FROM cbt_app;
REVOKE ALL ON SEQUENCE role_change_log_id_seq FROM cbt_app;

-- ==========================================
-- 5. ONE GUARDED PATH FOR ROLE CHANGES
-- ==========================================

CREATE OR REPLACE FUNCTION app_set_roles(
  p_actor_session uuid,
  p_target        uuid,
  p_roles         text[],
  p_scope_type    "ScopeType" DEFAULT 'GLOBAL',
  p_scope_id      uuid        DEFAULT NULL,
  p_request_id    text        DEFAULT 'db'
)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid;
  v_actor_ok   boolean;
  v_target     users%ROWTYPE;
  v_before     text[];
  v_after      text[];
  v_bad        text;
  v_admin_left integer;
BEGIN
  -- Exactly the three institution roles, no duplicates, never empty.
  IF p_roles IS NULL OR cardinality(p_roles) = 0 THEN
    RAISE EXCEPTION 'A user must keep at least one role'
      USING ERRCODE = 'check_violation';
  END IF;

  IF cardinality(p_roles) <> (SELECT count(DISTINCT r.role) FROM unnest(p_roles) AS r(role)) THEN
    RAISE EXCEPTION 'Duplicate roles are not allowed'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT r.key INTO v_bad
    FROM unnest(p_roles) AS r(key)
   WHERE r.key NOT IN ('ADMIN', 'LECTURER', 'STUDENT')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Unknown role %', v_bad
      USING ERRCODE = 'check_violation';
  END IF;

  -- Every requested role must exist in the catalogue. Without this, a missing
  -- catalogue row would silently grant fewer roles than asked for and leave the
  -- user unable to sign in, with no error to explain it.
  IF (SELECT count(*) FROM roles WHERE key = ANY (p_roles)) <> cardinality(p_roles) THEN
    RAISE EXCEPTION 'A requested role is missing from the catalogue; run the seed'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only GLOBAL grants are managed here; scoped grants are a separate design.
  IF p_scope_type IS DISTINCT FROM 'GLOBAL' OR p_scope_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only GLOBAL role grants are managed by this function'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The actor is derived from a live session, never trusted from an argument.
  -- The account behind the session must still be ACTIVE: a deactivated
  -- administrator whose session row has not been revoked yet must not be able
  -- to hand out roles.
  SELECT s.user_id INTO v_actor
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.id = p_actor_session
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.status = 'ACTIVE';

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Actor session is missing, revoked, expired, or the account is not active'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Authority is re-read from the database, not taken from a JWT claim.
  SELECT EXISTS (
    SELECT 1
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = v_actor
       AND r.key = 'ADMIN'
       AND ur.scope_type = 'GLOBAL'
  ) INTO v_actor_ok;

  IF NOT v_actor_ok THEN
    RAISE EXCEPTION 'Actor is not an administrator'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- No self-escalation and no self-demotion: another administrator must act.
  IF v_actor = p_target THEN
    RAISE EXCEPTION 'Administrators cannot change their own roles'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_target FROM users WHERE id = p_target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user does not exist'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT coalesce(array_agg(r.key ORDER BY r.key), '{}')
    INTO v_before
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_target
     AND ur.scope_type = 'GLOBAL';

  -- Never leave the institution without an active administrator.
  IF 'ADMIN' = ANY (v_before)
     AND NOT ('ADMIN' = ANY (p_roles))
     AND v_target.status = 'ACTIVE'
  THEN
    SELECT count(DISTINCT ur.user_id)
      INTO v_admin_left
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN users u ON u.id = ur.user_id
     WHERE r.key = 'ADMIN'
       AND ur.scope_type = 'GLOBAL'
       AND u.status = 'ACTIVE'
       AND ur.user_id <> p_target;

    IF v_admin_left < 1 THEN
      RAISE EXCEPTION 'At least one active administrator must remain'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  DELETE FROM user_roles
   WHERE user_id = p_target
     AND scope_type = 'GLOBAL';

  INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id)
  SELECT gen_random_uuid(), p_target, r.id, 'GLOBAL', NULL
    FROM roles r
   WHERE r.key = ANY (p_roles);

  SELECT array_agg(r.key ORDER BY r.key)
    INTO v_after
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_target
     AND ur.scope_type = 'GLOBAL';

  IF v_before IS DISTINCT FROM v_after THEN
    -- A role change invalidates every existing session, so a demotion takes
    -- effect immediately even if an access token is still inside its 15 minutes.
    UPDATE auth_sessions
       SET revoked_at = now(), revoked_reason = 'ROLE_CHANGE'
     WHERE user_id = p_target
       AND revoked_at IS NULL;

    INSERT INTO role_change_log (actor_id, target_id, before, after, session_id, request_id)
    VALUES (
      v_actor,
      p_target,
      v_before,
      v_after,
      p_actor_session,
      coalesce(nullif(p_request_id, ''), 'db')
    );
  END IF;

  RETURN v_after;
END;
$$;

-- Only the runtime role may call it, and only it — PUBLIC loses the default.
REVOKE ALL ON FUNCTION app_set_roles(uuid, uuid, text[], "ScopeType", uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_roles(uuid, uuid, text[], "ScopeType", uuid, text) TO cbt_app;

-- ==========================================
-- 6. SECOND LINE: DIRECT IDENTITY WRITES REJECTED
-- ==========================================
--
-- Privileges already stop cbt_app. This trigger also stops a future grant from
-- silently re-opening the door, and makes the rule explicit in the database.
-- The table owner (the migration/seed connection) is still allowed, because
-- the SECURITY DEFINER function executes as that owner.

CREATE OR REPLACE FUNCTION guard_identity_tables()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_get_userbyid(relowner) INTO v_owner
    FROM pg_class WHERE oid = TG_RELID;

  IF current_user = v_owner THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    '% is managed only through app_set_roles()', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER user_roles_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION guard_identity_tables();

CREATE TRIGGER user_permissions_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON user_permissions
  FOR EACH ROW EXECUTE FUNCTION guard_identity_tables();

CREATE TRIGGER roles_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION guard_identity_tables();

CREATE TRIGGER role_permissions_guarded
  BEFORE INSERT OR UPDATE OR DELETE ON role_permissions
  FOR EACH ROW EXECUTE FUNCTION guard_identity_tables();

-- ==========================================
-- 7. REMOVE THE RETIRED ROLES
-- ==========================================
--
-- Any database seeded before the three-role model still carries EXAM_OFFICER
-- and INVIGILATOR rows. Drop their grants, then the roles themselves. Affected
-- users are handled by the seed (deleted, or deactivated when history forbids
-- deletion), and cannot authenticate with no role in the meantime.

DELETE FROM user_roles
 WHERE role_id IN (
   SELECT id FROM roles WHERE key NOT IN ('ADMIN', 'LECTURER', 'STUDENT')
 );

DELETE FROM role_permissions
 WHERE role_id IN (
   SELECT id FROM roles WHERE key NOT IN ('ADMIN', 'LECTURER', 'STUDENT')
 );

DELETE FROM roles
 WHERE key NOT IN ('ADMIN', 'LECTURER', 'STUDENT');
