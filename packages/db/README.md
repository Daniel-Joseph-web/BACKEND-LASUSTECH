# `@lasustech-cbt/db`

The Prisma schema, migrations and seed for the LASUSTECH CBT system. Everything
that touches the database — the API, the worker and the scripts — imports the
generated client from here (`src/index.ts` re-exports `@prisma/client`).

## Daily workflow

```bash
# from the repo root
pnpm infra:up                                  # Postgres 16 + Redis 7
pnpm --filter @lasustech-cbt/db run generate   # regenerate the client after editing the schema
pnpm --filter @lasustech-cbt/db run migrate    # create + apply a migration, then re-seed
pnpm --filter @lasustech-cbt/db run seed       # re-run the seed on its own
pnpm --filter @lasustech-cbt/db run reset      # drop everything, re-migrate, re-seed
pnpm --filter @lasustech-cbt/db run studio     # browse the data
```

`migrate dev` and `reset` both run the seed automatically, because
`package.json` has a `prisma.seed` entry. The seed is idempotent — every write is
an upsert — so re-running it is always safe.

## What the seed creates

- 5 roles and the 5 demo logins (`admin@`, `officer@`, `bello@`, `invigilator@`,
  `nifemi@cbt.lasustech.edu.ng`), all sharing `SEED_PASSWORD`
  (`ChangeMe123!` by default). **Change it before this is reachable from
  anywhere but your machine.**
- The 5 LASUSTECH colleges, 38 departments, 39 programmes and 48 courses, plus
  the `programme_courses` links between them. Transcribed from what used to be
  the only copy of the structure, `lasustech-cbt/lib/lasustech-structure.ts`.
- Two academic sessions (2026/2027 current, 2025/2026 closed) and their semesters.
- The A–F grade bands for the Nigerian 5-point scale.

The source fixture carries no unit values, so every course is seeded at 3 units.
Correct them through `PATCH /admin/courses/:id` when the real load is known.

## Migration-owned SQL — read this before regenerating a migration

Four things in this database **cannot be expressed in `schema.prisma`**. They
live only in the migration, so Prisma cannot see them and will not warn you
before dropping them. If you ever squash the migrations, delete `migrations/`
and start again, or run `migrate diff`, they must be added back by hand.

```sql
-- 1. Case-insensitive identity columns (users.email / matric_no / staff_id).
--    auth.service.ts looks accounts up with mode: 'insensitive'; citext makes
--    the unique indexes genuinely case-insensitive instead of a seq scan.
CREATE EXTENSION IF NOT EXISTS citext;

-- 2 & 3. user_roles uniqueness. scope_id is nullable and Postgres treats NULLs
--    as distinct, so a plain UNIQUE (user_id, role_id, scope_type, scope_id)
--    would not constrain GLOBAL rows at all — you could grant ADMIN twice.
CREATE UNIQUE INDEX "user_roles_global_key"
  ON "user_roles" ("user_id", "role_id", "scope_type")
  WHERE "scope_id" IS NULL;

CREATE UNIQUE INDEX "user_roles_scoped_key"
  ON "user_roles" ("user_id", "role_id", "scope_type", "scope_id")
  WHERE "scope_id" IS NOT NULL;

-- 4. At most one current academic session.
CREATE UNIQUE INDEX "academic_sessions_one_current"
  ON "academic_sessions" ("is_current")
  WHERE "is_current";

-- 5. At most one current result per attempt.
CREATE UNIQUE INDEX "results_one_current_per_attempt"
  ON "results" ("attempt_id")
  WHERE "is_current";
```

Check they survived with:

```sql
SELECT indexname FROM pg_indexes WHERE indexname LIKE '%one_current%';
\d user_roles
```

## Two things that will silently break the audit chain

`audit_logs` is append-only and hash-chained (`apps/api/src/lib/audit.ts`).
`verifyChain()` re-derives each hash from the values it reads back out of
Postgres, so:

1. **`audit_logs.at` must stay `@db.Timestamptz(3)`.** The hash covers
   `at.toISOString()`. Widening the column to microseconds changes what comes
   back out and breaks verification of every existing row.
2. **The hashed fields must stay in the same order.** Adding, removing or
   reordering a field in `computeHash`'s array invalidates the whole chain.

Never `UPDATE` or `DELETE` from `audit_logs`. A chain that fails verification is
working as designed — it means a row was altered.

## Where the rest of the design is written down

The schema file itself carries the reasoning in comments at each model: why
`current_version_id` uses `SetNull`, why `Question` and `QuestionVersion` need
two named relations, why `ModerationReview.target_id` is a loose uuid with no
foreign key. Read those before changing a relation.
