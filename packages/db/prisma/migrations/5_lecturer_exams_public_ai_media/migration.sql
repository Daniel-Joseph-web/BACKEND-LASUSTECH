-- Lecturer-owned exams, public exams, AI answer provenance and question media.
--
-- Hand-written rather than generated because `prisma migrate dev` is not
-- reachable from this environment. It is additive: no existing column, index
-- or hand-written partial index is dropped or rewritten. Review the statements
-- with `prisma migrate status` / `migrate deploy` before applying.

-- ==========================================
-- ENUMERATIONS
-- ==========================================

CREATE TYPE "ExamAudience" AS ENUM ('INSTITUTIONAL', 'PUBLIC');
CREATE TYPE "AnswerSource" AS ENUM ('SOURCE', 'LECTURER', 'AI_SUGGESTED', 'AI_GENERATED');

-- CUSTOM covers schools, entrance exams and professional bodies. The free-text
-- `kindLabel` on Exam carries the exact name shown to candidates.
ALTER TYPE "ExamKind" ADD VALUE 'CUSTOM';

-- ==========================================
-- SUBJECTS (school / entrance / external papers)
-- ==========================================

CREATE TABLE "subjects" (
    "id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "level" TEXT,
    "institution" TEXT,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subjects_created_by_active_idx" ON "subjects"("created_by", "active");

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ==========================================
-- QUESTION BANK
-- ==========================================

-- A question now belongs to either a course or a subject.
ALTER TABLE "questions" ALTER COLUMN "course_id" DROP NOT NULL;
ALTER TABLE "questions" ADD COLUMN "subject_id" UUID;
CREATE INDEX "questions_subject_id_idx" ON "questions"("subject_id");
ALTER TABLE "questions" ADD CONSTRAINT "questions_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "topics" ALTER COLUMN "course_id" DROP NOT NULL;
ALTER TABLE "topics" ADD COLUMN "subject_id" UUID;
CREATE UNIQUE INDEX "topics_subject_id_name_key" ON "topics"("subject_id", "name");
CREATE INDEX "topics_subject_id_idx" ON "topics"("subject_id");
ALTER TABLE "topics" ADD CONSTRAINT "topics_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Provenance for keys supplied by AI during an import, so a lecturer can see
-- which answers still need checking.
ALTER TABLE "question_versions" ADD COLUMN "answer_source" "AnswerSource" NOT NULL DEFAULT 'SOURCE';
ALTER TABLE "question_versions" ADD COLUMN "ai_model" TEXT;
CREATE INDEX "question_versions_answer_source_idx" ON "question_versions"("answer_source");

-- Image ownership; dedupe stays on sha256/object_key.
ALTER TABLE "media_assets" ADD COLUMN "uploaded_by" UUID;
CREATE INDEX "media_assets_uploaded_by_idx" ON "media_assets"("uploaded_by");
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_fkey"
    FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ==========================================
-- EXAMS
-- ==========================================

-- Subject exams have no academic session; only institution course exams do.
ALTER TABLE "exams" ALTER COLUMN "course_id" DROP NOT NULL;
ALTER TABLE "exams" ALTER COLUMN "session_id" DROP NOT NULL;

ALTER TABLE "exams" ADD COLUMN "subject_id" UUID;
ALTER TABLE "exams" ADD COLUMN "created_by" UUID;
ALTER TABLE "exams" ADD COLUMN "kind_label" TEXT;
ALTER TABLE "exams" ADD COLUMN "audience" "ExamAudience" NOT NULL DEFAULT 'INSTITUTIONAL';
ALTER TABLE "exams" ADD COLUMN "institution_name" TEXT;
ALTER TABLE "exams" ADD COLUMN "level_label" TEXT;
ALTER TABLE "exams" ADD COLUMN "exam_board" TEXT;
ALTER TABLE "exams" ADD COLUMN "duration_min" INTEGER;
ALTER TABLE "exams" ADD COLUMN "pass_mark" DECIMAL(5,2);
ALTER TABLE "exams" ADD COLUMN "public_slug" TEXT;
ALTER TABLE "exams" ADD COLUMN "public_access_code_hash" TEXT;
ALTER TABLE "exams" ADD COLUMN "public_opens_at" TIMESTAMPTZ(3);
ALTER TABLE "exams" ADD COLUMN "public_closes_at" TIMESTAMPTZ(3);
ALTER TABLE "exams" ADD COLUMN "published_at" TIMESTAMPTZ(3);

CREATE INDEX "exams_subject_id_idx" ON "exams"("subject_id");
CREATE INDEX "exams_audience_status_idx" ON "exams"("audience", "status");
CREATE UNIQUE INDEX "exams_public_slug_key" ON "exams"("public_slug");

ALTER TABLE "exams" ADD CONSTRAINT "exams_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "exams" ADD CONSTRAINT "exams_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ==========================================
-- SITTINGS AND ATTEMPTS
-- ==========================================

-- Exams are taken online, so a venue is optional. Public exams get one hidden
-- sitting (`is_public = true`) that never blocks an institution sitting.
ALTER TABLE "sittings" ALTER COLUMN "venue" DROP NOT NULL;
ALTER TABLE "sittings" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "sittings_starts_at_ends_at_idx" ON "sittings"("starts_at", "ends_at");

-- Anonymous public candidates are guest users; the email (when supplied) is
-- copied here so one email can only submit one attempt per exam.
ALTER TABLE "attempts" ADD COLUMN "guest_email" TEXT;
CREATE INDEX "attempts_sitting_id_guest_email_idx" ON "attempts"("sitting_id", "guest_email");

ALTER TABLE "users" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;

-- ==========================================
-- OPTIONAL SCOPE RELATIONS
-- ==========================================
-- Making course_id/session_id optional changes Prisma's referential action
-- from RESTRICT to SET NULL. Recreate the constraints so `prisma migrate dev`
-- does not report drift; the API still refuses to delete a referenced course.

ALTER TABLE "questions" DROP CONSTRAINT "questions_course_id_fkey";
ALTER TABLE "questions" ADD CONSTRAINT "questions_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "topics" DROP CONSTRAINT "topics_course_id_fkey";
ALTER TABLE "topics" ADD CONSTRAINT "topics_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "exams" DROP CONSTRAINT "exams_course_id_fkey";
ALTER TABLE "exams" ADD CONSTRAINT "exams_course_id_fkey"
    FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "exams" DROP CONSTRAINT "exams_session_id_fkey";
ALTER TABLE "exams" ADD CONSTRAINT "exams_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "academic_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

