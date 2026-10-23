-- Integrity layer that Prisma cannot express.
--
-- Everything here is deliberate hand-written SQL running after the generated
-- schema in 0_init. `prisma migrate dev` does not know about these objects and
-- will propose dropping some of them on the next diff — do not let it.
--
-- Covered:
--   * extensions the schema relies on (citext, pg_trgm);
--   * "at most one current row" partial unique indexes;
--   * scope-aware uniqueness for user_roles;
--   * range/temporal CHECK constraints;
--   * append-only audit_logs;
--   * trigram search indexes for name/code/title lookup.

-- ==========================================
-- EXTENSIONS
-- ==========================================

-- users.email / matric_no / staff_id are @db.Citext, so this must exist before
-- 0_init runs. It is repeated here with IF NOT EXISTS so the hand-written
-- migration is also safe on a database where 0_init created it already.
CREATE EXTENSION IF NOT EXISTS "citext";

-- Fuzzy search across users.names and courses.code/title.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ==========================================
-- AT MOST ONE CURRENT ROW
-- ==========================================
--
-- A plain UNIQUE cannot express "only one row flagged current": the predicate
-- column is what differs between the rows we want to exclude, not the key.
-- A partial unique index over a constant-free column plus WHERE is_current
-- allows exactly one TRUE row and any number of FALSE rows.

CREATE UNIQUE INDEX "academic_sessions_one_current_key"
  ON "academic_sessions" ("is_current")
  WHERE "is_current" = true;

-- Scoring writes a new result row per score version and flips is_current.
-- At any moment exactly one version may be current per attempt.
CREATE UNIQUE INDEX "results_one_current_per_attempt_key"
  ON "results" ("attempt_id")
  WHERE "is_current" = true;

-- ==========================================
-- SCOPE-AWARE ROLE UNIQUENESS
-- ==========================================
--
-- user_roles.scope_id is nullable and Postgres treats NULLs as distinct, so
-- @@unique([userId, roleId, scopeType, scopeId]) would never constrain GLOBAL
-- grants. Split into two partial indexes instead: one for global grants (where
-- scope_id must be NULL) and one for scoped grants (where it must be set).

CREATE UNIQUE INDEX "user_roles_global_key"
  ON "user_roles" ("user_id", "role_id")
  WHERE "scope_id" IS NULL;

CREATE UNIQUE INDEX "user_roles_scoped_key"
  ON "user_roles" ("user_id", "role_id", "scope_type", "scope_id")
  WHERE "scope_id" IS NOT NULL;

-- Same NULL-distinctness problem on per-user permission grants: the schema's
-- @@unique([userId, permissionKey, scopeType, scopeId]) never constrains a
-- GLOBAL grant. Scoped grants are covered by that unique index, so only the
-- global case needs a partial one here.
CREATE UNIQUE INDEX "user_permissions_global_key"
  ON "user_permissions" ("user_id", "permission_key")
  WHERE "scope_id" IS NULL;

-- ==========================================
-- RANGE AND TEMPORAL CHECKS
-- ==========================================

-- A session cannot end before it starts.
ALTER TABLE "academic_sessions"
  ADD CONSTRAINT "academic_sessions_dates_check"
  CHECK ("ends_on" > "starts_on");

-- A semester cannot end before it starts.
ALTER TABLE "semesters"
  ADD CONSTRAINT "semesters_dates_check"
  CHECK ("ends_on" > "starts_on");

-- A sitting cannot close before it opens.
ALTER TABLE "sittings"
  ADD CONSTRAINT "sittings_window_check"
  CHECK ("ends_at" > "starts_at");

-- Grading scale rows must describe a real, ordered band inside 0..100.
ALTER TABLE "grade_bands"
  ADD CONSTRAINT "grade_bands_range_check"
  CHECK ("min_percent" >= 0 AND "max_percent" <= 100 AND "min_percent" <= "max_percent");

-- A result can never be negative, exceed its maximum, or report a percentage
-- outside 0..100. This is the last line of defence behind the scoring worker.
ALTER TABLE "results"
  ADD CONSTRAINT "results_score_check"
  CHECK (
    "raw_score" >= 0
    AND "max_score" > 0
    AND "raw_score" <= "max_score"
    AND "percent" >= 0
    AND "percent" <= 100
  );

-- Authoring: a question version worth zero marks cannot be marked.
ALTER TABLE "question_versions"
  ADD CONSTRAINT "question_versions_marks_check"
  CHECK ("marks" > 0);

-- A selection rule must ask for at least one question worth at least something.
ALTER TABLE "exam_rules"
  ADD CONSTRAINT "exam_rules_count_marks_check"
  CHECK ("count" > 0 AND "marks" > 0);

-- A section's weight scales its contribution; zero or negative weights make
-- the weighted total meaningless.
ALTER TABLE "exam_sections"
  ADD CONSTRAINT "exam_sections_weight_check"
  CHECK ("weight" > 0);

-- GLOBAL grants carry no scope; every other scope must name one.
ALTER TABLE "user_roles"
  ADD CONSTRAINT "user_roles_scope_check"
  CHECK (
    ("scope_type" = 'GLOBAL' AND "scope_id" IS NULL)
    OR ("scope_type" <> 'GLOBAL' AND "scope_id" IS NOT NULL)
  );

ALTER TABLE "user_permissions"
  ADD CONSTRAINT "user_permissions_scope_check"
  CHECK (
    ("scope_type" = 'GLOBAL' AND "scope_id" IS NULL)
    OR ("scope_type" <> 'GLOBAL' AND "scope_id" IS NOT NULL)
  );

-- An uploaded asset with no bytes is a failed upload, not an asset.
ALTER TABLE "media_assets"
  ADD CONSTRAINT "media_assets_bytes_check"
  CHECK ("bytes" > 0);

-- ==========================================
-- APPEND-ONLY AUDIT LOG
-- ==========================================
--
-- audit_logs is hash-chained (apps/api/src/lib/audit.ts). The chain only proves
-- anything if past rows cannot be rewritten: an attacker with UPDATE/DELETE
-- could otherwise recompute the whole chain. The application never updates or
-- deletes audit rows; this trigger makes that a database-level guarantee rather
-- than a convention.
--
-- Rows are still removed — deliberately and wholly — by `prisma migrate reset`,
-- which drops the schema rather than deleting rows, so this does not block
-- development resets.

CREATE OR REPLACE FUNCTION "audit_logs_reject_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only: % on row % rejected', TG_OP, OLD."id"
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_logs_immutable"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION "audit_logs_reject_mutation"();

-- Row triggers do not fire on TRUNCATE, which would otherwise wipe the chain in
-- one statement. A statement-level trigger closes that hole.
CREATE OR REPLACE FUNCTION "audit_logs_reject_truncate"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_logs is append-only: TRUNCATE rejected'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "audit_logs_immutable_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "audit_logs_reject_truncate"();

-- ==========================================
-- SEARCH INDEXES
-- ==========================================
--
-- The admin screens search by partial name and course code/title. Without
-- these, ILIKE '%term%' is a sequential scan of the largest tables.

CREATE INDEX "users_names_trgm_idx"
  ON "users" USING gin ("names" gin_trgm_ops);

CREATE INDEX "courses_code_trgm_idx"
  ON "courses" USING gin ("code" gin_trgm_ops);

CREATE INDEX "courses_title_trgm_idx"
  ON "courses" USING gin ("title" gin_trgm_ops);
