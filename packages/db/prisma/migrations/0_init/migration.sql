-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AnswerFormat" AS ENUM ('MCQ_SINGLE', 'MCQ_MULTI', 'MATCHING');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'PENDING', 'RETURNED', 'APPROVED', 'LOCKED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ExamStatus" AS ENUM ('DRAFT', 'IN_MODERATION', 'APPROVED', 'LOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ExamKind" AS ENUM ('MID_SEMESTER', 'END_OF_SEMESTER', 'MOCK', 'QUIZ', 'RESIT', 'SUPPLEMENTARY');

-- CreateEnum
CREATE TYPE "SittingStatus" AS ENUM ('SCHEDULED', 'OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'PAUSED', 'SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AttemptEndedReason" AS ENUM ('STUDENT_SUBMIT', 'AUTO_SUBMIT', 'EXPIRED', 'TERMINATED', 'INVIGILATOR_END');

-- CreateEnum
CREATE TYPE "ClockPolicy" AS ENUM ('RUNNING', 'PAUSE_ON_DISCONNECT');

-- CreateEnum
CREATE TYPE "TimerMode" AS ENUM ('PER_STUDENT_START', 'FIXED_END');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('SCORED', 'LECTURER_SUBMITTED', 'APPROVED', 'RELEASED', 'AMENDED');

-- CreateEnum
CREATE TYPE "Grade" AS ENUM ('A', 'B', 'C', 'D', 'E', 'F');

-- CreateEnum
CREATE TYPE "ResultBatchStatus" AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'RELEASED');

-- CreateEnum
CREATE TYPE "InterventionAction" AS ENUM ('PAUSE', 'RESUME', 'EXTEND', 'RESET_SESSION', 'END', 'MESSAGE');

-- CreateEnum
CREATE TYPE "FlagSeverity" AS ENUM ('INFO', 'WARNING', 'HIGH');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'LOCKED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('GLOBAL', 'COLLEGE', 'DEPARTMENT', 'COURSE');

-- CreateEnum
CREATE TYPE "CourseAssignmentRole" AS ENUM ('LECTURER', 'COORDINATOR');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'DROPPED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SemesterName" AS ENUM ('FIRST', 'SECOND');

-- CreateEnum
CREATE TYPE "TimerModeSection" AS ENUM ('SHARED', 'OWN');

-- CreateEnum
CREATE TYPE "RuleMode" AS ENUM ('BY_RULE', 'FIXED');

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('LAB', 'REMOTE');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('INVITE', 'RESET', 'VERIFY');

-- CreateEnum
CREATE TYPE "ModerationDecision" AS ENUM ('APPROVED', 'RETURNED', 'LOCKED');

-- CreateEnum
CREATE TYPE "ModerationTarget" AS ENUM ('QUESTION_VERSION', 'EXAM');

-- CreateEnum
CREATE TYPE "AppealStatus" AS ENUM ('NEW', 'UNDER_REVIEW', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AppealOutcome" AS ENUM ('KEEP', 'CHANGE_SCORE', 'FIX_KEY');

-- CreateEnum
CREATE TYPE "MediaScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('USER_BULK_IMPORT', 'QUESTION_BULK_IMPORT', 'USER_EXPORT', 'QUESTION_EXPORT', 'RESULT_EXPORT', 'AUDIT_EXPORT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SYSTEM', 'EXAM_REMINDER', 'STUDENT_DISCONNECT', 'OFFICER_APPROVAL', 'HEALTH_ALERT', 'RESULT_RELEASED');

-- CreateTable
CREATE TABLE "colleges" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dean" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "colleges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "college_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "head_name" TEXT,
    "hod_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programmes" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "award" TEXT NOT NULL,
    "duration_years" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "programmes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "courses" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "level" INTEGER NOT NULL,
    "default_semester" "SemesterName" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programme_courses" (
    "programme_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "semester" "SemesterName" NOT NULL,
    "compulsory" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "programme_courses_pkey" PRIMARY KEY ("programme_id","course_id")
);

-- CreateTable
CREATE TABLE "academic_sessions" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "academic_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "semesters" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "name" "SemesterName" NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,

    CONSTRAINT "semesters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_assignments" (
    "course_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "role" "CourseAssignmentRole" NOT NULL,

    CONSTRAINT "course_assignments_pkey" PRIMARY KEY ("course_id","user_id","session_id","role")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "student_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("student_id","course_id","session_id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "matric_no" CITEXT,
    "staff_id" CITEXT,
    "email" CITEXT,
    "phone" TEXT,
    "names" TEXT NOT NULL,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "department_id" UUID,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "password_set_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "scope_id" UUID,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "scope_id" UUID,
    "granted_by" UUID,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_profiles" (
    "user_id" UUID NOT NULL,
    "programme_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "admission_year" INTEGER NOT NULL,
    "photo_object_key" TEXT,

    CONSTRAINT "student_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "student_accommodations" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "extra_time_pct" INTEGER,
    "extra_time_min" INTEGER,
    "large_text" BOOLEAN NOT NULL DEFAULT false,
    "high_contrast" BOOLEAN NOT NULL DEFAULT false,
    "separate_room" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "applies_to" TEXT,

    CONSTRAINT "student_accommodations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "device_hash" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_secrets" (
    "user_id" UUID NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "enabled_at" TIMESTAMPTZ(3) NOT NULL,
    "backup_codes_hash" TEXT[],

    CONSTRAINT "mfa_secrets_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "one_time_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "one_time_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "meta" JSONB,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "answer_format" "AnswerFormat" NOT NULL,
    "current_version_id" UUID,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_versions" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "stem" JSONB NOT NULL,
    "stem_media_id" UUID,
    "has_math" BOOLEAN NOT NULL DEFAULT false,
    "explanation" TEXT,
    "topic_id" UUID NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "marks" DECIMAL(6,2) NOT NULL,
    "status" "QuestionStatus" NOT NULL DEFAULT 'DRAFT',
    "author_id" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "content_hash" TEXT,

    CONSTRAINT "question_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "options" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "media_id" UUID,
    "is_correct" BOOLEAN NOT NULL,

    CONSTRAINT "options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pairs" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "left_body" JSONB NOT NULL,
    "right_body" JSONB NOT NULL,

    CONSTRAINT "pairs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "version_tags" (
    "version_id" UUID NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "version_tags_pkey" PRIMARY KEY ("version_id","tag")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "alt_text" TEXT NOT NULL,
    "scan_status" "MediaScanStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_reviews" (
    "id" UUID NOT NULL,
    "target_type" "ModerationTarget" NOT NULL,
    "target_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "decision" "ModerationDecision" NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exams" (
    "id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ExamKind" NOT NULL DEFAULT 'MID_SEMESTER',
    "instructions" JSONB,
    "status" "ExamStatus" NOT NULL DEFAULT 'DRAFT',
    "settings" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "locked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_sections" (
    "id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "timer_mode" "TimerModeSection" NOT NULL,
    "minutes" INTEGER,
    "weight" DECIMAL(4,2) NOT NULL DEFAULT 1.0,

    CONSTRAINT "exam_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_rules" (
    "id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "mode" "RuleMode" NOT NULL,
    "difficulty" "Difficulty",
    "topic_id" UUID,
    "count" INTEGER NOT NULL,
    "marks" DECIMAL(6,2) NOT NULL,

    CONSTRAINT "exam_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exam_questions" (
    "section_id" UUID NOT NULL,
    "question_version_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "exam_questions_pkey" PRIMARY KEY ("section_id","question_version_id")
);

-- CreateTable
CREATE TABLE "paper_bundles" (
    "id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "wrapped_dek" TEXT NOT NULL,
    "kms_key_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "pool_size" INTEGER NOT NULL,
    "opened_at" TIMESTAMPTZ(3),

    CONSTRAINT "paper_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "location" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sittings" (
    "id" UUID NOT NULL,
    "exam_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "timer_mode" "TimerMode" NOT NULL,
    "late_grace_min" INTEGER NOT NULL,
    "late_cutoff_min" INTEGER NOT NULL,
    "clock_policy" "ClockPolicy" NOT NULL,
    "max_pause_min" INTEGER NOT NULL,
    "reconnect_grace_sec" INTEGER NOT NULL,
    "venue" TEXT NOT NULL,
    "venue_id" UUID,
    "delivery_mode" "DeliveryMode" NOT NULL,
    "require_webcam" BOOLEAN NOT NULL,
    "require_seb" BOOLEAN NOT NULL,
    "access_code_hash" TEXT NOT NULL,
    "status" "SittingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sittings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sitting_students" (
    "sitting_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "extra_minutes" INTEGER NOT NULL DEFAULT 0,
    "seat_label" TEXT,

    CONSTRAINT "sitting_students_pkey" PRIMARY KEY ("sitting_id","student_id")
);

-- CreateTable
CREATE TABLE "sitting_invigilators" (
    "sitting_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "sitting_invigilators_pkey" PRIMARY KEY ("sitting_id","user_id")
);

-- CreateTable
CREATE TABLE "attempts" (
    "id" UUID NOT NULL,
    "sitting_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL DEFAULT 1,
    "status" "AttemptStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "started_at" TIMESTAMPTZ(3),
    "deadline_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "ended_reason" "AttemptEndedReason",
    "extra_minutes" INTEGER NOT NULL DEFAULT 0,
    "paused_at" TIMESTAMPTZ(3),
    "paused_total_sec" INTEGER NOT NULL DEFAULT 0,
    "session_id" UUID,
    "device_hash" TEXT,
    "ip_start" TEXT,
    "seed" BYTEA,
    "question_count" INTEGER NOT NULL,
    "total_marks" DECIMAL(7,2) NOT NULL,
    "last_sync_seq" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_questions" (
    "attempt_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "question_version_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "weighted_marks" DECIMAL(6,2) NOT NULL,
    "option_order" INTEGER[],

    CONSTRAINT "attempt_questions_pkey" PRIMARY KEY ("attempt_id","position")
);

-- CreateTable
CREATE TABLE "answers" (
    "attempt_id" UUID NOT NULL,
    "question_version_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "client_seq" BIGINT NOT NULL,
    "answered_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("attempt_id","question_version_id")
);

-- CreateTable
CREATE TABLE "answer_events" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "question_version_id" UUID NOT NULL,
    "value" JSONB NOT NULL,
    "client_seq" BIGINT NOT NULL,
    "client_ts" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "answer_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attempt_events" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "client_ts" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attempt_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flags" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "rule_key" TEXT NOT NULL,
    "severity" "FlagSeverity" NOT NULL,
    "details" JSONB,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interventions" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" "InterventionAction" NOT NULL,
    "params" JSONB,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proctor_snapshots" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "taken_at" TIMESTAMPTZ(3) NOT NULL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "proctor_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "results" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "score_version" INTEGER NOT NULL,
    "raw_score" DECIMAL(7,2) NOT NULL,
    "max_score" DECIMAL(7,2) NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "grade" "Grade" NOT NULL,
    "status" "ResultStatus" NOT NULL,
    "is_current" BOOLEAN NOT NULL,
    "scored_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_scores" (
    "result_id" UUID NOT NULL,
    "section_id" UUID NOT NULL,
    "score" DECIMAL(7,2) NOT NULL,
    "max_score" DECIMAL(7,2) NOT NULL,

    CONSTRAINT "section_scores_pkey" PRIMARY KEY ("result_id","section_id")
);

-- CreateTable
CREATE TABLE "grade_bands" (
    "grade" "Grade" NOT NULL,
    "min_percent" DECIMAL(5,2) NOT NULL,
    "max_percent" DECIMAL(5,2) NOT NULL,
    "point" DECIMAL(3,2) NOT NULL,
    "label" TEXT,

    CONSTRAINT "grade_bands_pkey" PRIMARY KEY ("grade")
);

-- CreateTable
CREATE TABLE "result_batches" (
    "id" UUID NOT NULL,
    "sitting_id" UUID NOT NULL,
    "status" "ResultBatchStatus" NOT NULL DEFAULT 'PENDING',
    "submitted_by" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "released_by" UUID,
    "released_at" TIMESTAMPTZ(3),
    "release_at" TIMESTAMPTZ(3),

    CONSTRAINT "result_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeals" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AppealStatus" NOT NULL DEFAULT 'NEW',
    "outcome" "AppealOutcome",
    "assignee_id" UUID,
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "score_changes" (
    "id" UUID NOT NULL,
    "result_id" UUID NOT NULL,
    "appeal_id" UUID,
    "old_score" DECIMAL(7,2) NOT NULL,
    "new_score" DECIMAL(7,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "score_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_pushes" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "response" JSONB,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_pushes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID NOT NULL,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "input_object_key" TEXT NOT NULL,
    "result_object_key" TEXT,
    "errors" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "input_object_key" TEXT NOT NULL,
    "result_object_key" TEXT,
    "errors" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "colleges_code_key" ON "colleges"("code");

-- CreateIndex
CREATE INDEX "departments_college_id_idx" ON "departments"("college_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_college_id_code_key" ON "departments"("college_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "programmes_department_id_code_key" ON "programmes"("department_id", "code");

-- CreateIndex
CREATE INDEX "courses_level_idx" ON "courses"("level");

-- CreateIndex
CREATE INDEX "courses_department_id_active_idx" ON "courses"("department_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "courses_department_id_code_key" ON "courses"("department_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "academic_sessions_name_key" ON "academic_sessions"("name");

-- CreateIndex
CREATE UNIQUE INDEX "semesters_session_id_name_key" ON "semesters"("session_id", "name");

-- CreateIndex
CREATE INDEX "course_assignments_user_id_session_id_idx" ON "course_assignments"("user_id", "session_id");

-- CreateIndex
CREATE INDEX "course_assignments_session_id_role_idx" ON "course_assignments"("session_id", "role");

-- CreateIndex
CREATE INDEX "enrollments_course_id_session_id_idx" ON "enrollments"("course_id", "session_id");

-- CreateIndex
CREATE INDEX "enrollments_session_id_status_idx" ON "enrollments"("session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_matric_no_key" ON "users"("matric_no");

-- CreateIndex
CREATE UNIQUE INDEX "users_staff_id_key" ON "users"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_department_id_status_idx" ON "users"("department_id", "status");

-- CreateIndex
CREATE INDEX "users_status_names_idx" ON "users"("status", "names");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_key_key" ON "role_permissions"("role_id", "permission_key");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_permissions_user_id_permission_key_scope_type_scope_id_key" ON "user_permissions"("user_id", "permission_key", "scope_type", "scope_id");

-- CreateIndex
CREATE INDEX "student_accommodations_student_id_valid_to_idx" ON "student_accommodations"("student_id", "valid_to");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_family_id_idx" ON "auth_sessions"("family_id");

-- CreateIndex
CREATE INDEX "auth_sessions_created_at_idx" ON "auth_sessions"("created_at");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_tokens_token_hash_purpose_key" ON "one_time_tokens"("token_hash", "purpose");

-- CreateIndex
CREATE INDEX "password_history_user_id_set_at_idx" ON "password_history"("user_id", "set_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "questions_current_version_id_key" ON "questions"("current_version_id");

-- CreateIndex
CREATE INDEX "questions_course_id_idx" ON "questions"("course_id");

-- CreateIndex
CREATE INDEX "questions_created_by_idx" ON "questions"("created_by");

-- CreateIndex
CREATE INDEX "question_versions_status_idx" ON "question_versions"("status");

-- CreateIndex
CREATE INDEX "question_versions_status_topic_id_difficulty_idx" ON "question_versions"("status", "topic_id", "difficulty");

-- CreateIndex
CREATE INDEX "question_versions_author_id_idx" ON "question_versions"("author_id");

-- CreateIndex
CREATE UNIQUE INDEX "question_versions_question_id_version_no_key" ON "question_versions"("question_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "options_version_id_position_key" ON "options"("version_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "pairs_version_id_position_key" ON "pairs"("version_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "topics_course_id_name_key" ON "topics"("course_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_object_key_key" ON "media_assets"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_sha256_key" ON "media_assets"("sha256");

-- CreateIndex
CREATE INDEX "moderation_reviews_target_type_target_id_idx" ON "moderation_reviews"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "moderation_reviews_reviewer_id_created_at_idx" ON "moderation_reviews"("reviewer_id", "created_at");

-- CreateIndex
CREATE INDEX "exams_course_id_session_id_status_idx" ON "exams"("course_id", "session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "exam_sections_exam_id_position_key" ON "exam_sections"("exam_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "exam_questions_section_id_position_key" ON "exam_questions"("section_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "venues_code_key" ON "venues"("code");

-- CreateIndex
CREATE INDEX "sittings_starts_at_status_idx" ON "sittings"("starts_at", "status");

-- CreateIndex
CREATE INDEX "sittings_exam_id_status_idx" ON "sittings"("exam_id", "status");

-- CreateIndex
CREATE INDEX "sitting_students_student_id_idx" ON "sitting_students"("student_id");

-- CreateIndex
CREATE INDEX "attempts_status_deadline_at_idx" ON "attempts"("status", "deadline_at");

-- CreateIndex
CREATE INDEX "attempts_student_id_status_idx" ON "attempts"("student_id", "status");

-- CreateIndex
CREATE INDEX "attempts_session_id_idx" ON "attempts"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "attempts_sitting_id_student_id_attempt_no_key" ON "attempts"("sitting_id", "student_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "attempt_questions_attempt_id_question_version_id_key" ON "attempt_questions"("attempt_id", "question_version_id");

-- CreateIndex
CREATE INDEX "answer_events_attempt_id_client_seq_idx" ON "answer_events"("attempt_id", "client_seq");

-- CreateIndex
CREATE INDEX "attempt_events_attempt_id_received_at_idx" ON "attempt_events"("attempt_id", "received_at");

-- CreateIndex
CREATE INDEX "flags_attempt_id_idx" ON "flags"("attempt_id");

-- CreateIndex
CREATE INDEX "flags_attempt_id_severity_idx" ON "flags"("attempt_id", "severity");

-- CreateIndex
CREATE INDEX "flags_reviewed_at_idx" ON "flags"("reviewed_at");

-- CreateIndex
CREATE INDEX "interventions_attempt_id_created_at_idx" ON "interventions"("attempt_id", "created_at");

-- CreateIndex
CREATE INDEX "proctor_snapshots_attempt_id_taken_at_idx" ON "proctor_snapshots"("attempt_id", "taken_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_key" ON "idempotency_keys"("user_id", "key");

-- CreateIndex
CREATE INDEX "results_is_current_percent_idx" ON "results"("is_current", "percent");

-- CreateIndex
CREATE UNIQUE INDEX "results_attempt_id_score_version_key" ON "results"("attempt_id", "score_version");

-- CreateIndex
CREATE UNIQUE INDEX "result_batches_sitting_id_key" ON "result_batches"("sitting_id");

-- CreateIndex
CREATE INDEX "result_batches_status_idx" ON "result_batches"("status");

-- CreateIndex
CREATE INDEX "appeals_status_created_at_idx" ON "appeals"("status", "created_at");

-- CreateIndex
CREATE INDEX "appeals_student_id_idx" ON "appeals"("student_id");

-- CreateIndex
CREATE INDEX "score_changes_result_id_idx" ON "score_changes"("result_id");

-- CreateIndex
CREATE UNIQUE INDEX "portal_pushes_batch_id_payload_hash_key" ON "portal_pushes"("batch_id", "payload_hash");

-- CreateIndex
CREATE INDEX "audit_logs_at_idx" ON "audit_logs"("at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_at_idx" ON "audit_logs"("actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_attempt_at_idx" ON "outbox_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "import_jobs_created_by_created_at_idx" ON "import_jobs"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");

-- CreateIndex
CREATE INDEX "export_jobs_created_by_created_at_idx" ON "export_jobs"("created_by", "created_at");

-- CreateIndex
CREATE INDEX "export_jobs_status_idx" ON "export_jobs"("status");

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "colleges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_hod_user_id_fkey" FOREIGN KEY ("hod_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programmes" ADD CONSTRAINT "programmes_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programme_courses" ADD CONSTRAINT "programme_courses_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programme_courses" ADD CONSTRAINT "programme_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "semesters" ADD CONSTRAINT "semesters_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "academic_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_assignments" ADD CONSTRAINT "course_assignments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "academic_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "academic_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_programme_id_fkey" FOREIGN KEY ("programme_id") REFERENCES "programmes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_accommodations" ADD CONSTRAINT "student_accommodations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_secrets" ADD CONSTRAINT "mfa_secrets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "question_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_versions" ADD CONSTRAINT "question_versions_stem_media_id_fkey" FOREIGN KEY ("stem_media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options" ADD CONSTRAINT "options_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "options" ADD CONSTRAINT "options_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pairs" ADD CONSTRAINT "pairs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "version_tags" ADD CONSTRAINT "version_tags_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "question_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moderation_reviews" ADD CONSTRAINT "moderation_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exams" ADD CONSTRAINT "exams_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "academic_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_sections" ADD CONSTRAINT "exam_sections_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_rules" ADD CONSTRAINT "exam_rules_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "exam_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_rules" ADD CONSTRAINT "exam_rules_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "exam_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exam_questions" ADD CONSTRAINT "exam_questions_question_version_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_bundles" ADD CONSTRAINT "paper_bundles_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sittings" ADD CONSTRAINT "sittings_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sittings" ADD CONSTRAINT "sittings_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sitting_students" ADD CONSTRAINT "sitting_students_sitting_id_fkey" FOREIGN KEY ("sitting_id") REFERENCES "sittings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sitting_students" ADD CONSTRAINT "sitting_students_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sitting_invigilators" ADD CONSTRAINT "sitting_invigilators_sitting_id_fkey" FOREIGN KEY ("sitting_id") REFERENCES "sittings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sitting_invigilators" ADD CONSTRAINT "sitting_invigilators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_sitting_id_fkey" FOREIGN KEY ("sitting_id") REFERENCES "sittings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_question_version_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_questions" ADD CONSTRAINT "attempt_questions_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "exam_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_version_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_events" ADD CONSTRAINT "answer_events_question_version_id_fkey" FOREIGN KEY ("question_version_id") REFERENCES "question_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flags" ADD CONSTRAINT "flags_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flags" ADD CONSTRAINT "flags_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interventions" ADD CONSTRAINT "interventions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proctor_snapshots" ADD CONSTRAINT "proctor_snapshots_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "results" ADD CONSTRAINT "results_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_scores" ADD CONSTRAINT "section_scores_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_scores" ADD CONSTRAINT "section_scores_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "exam_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_batches" ADD CONSTRAINT "result_batches_sitting_id_fkey" FOREIGN KEY ("sitting_id") REFERENCES "sittings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_batches" ADD CONSTRAINT "result_batches_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_batches" ADD CONSTRAINT "result_batches_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_batches" ADD CONSTRAINT "result_batches_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_changes" ADD CONSTRAINT "score_changes_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_changes" ADD CONSTRAINT "score_changes_appeal_id_fkey" FOREIGN KEY ("appeal_id") REFERENCES "appeals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_changes" ADD CONSTRAINT "score_changes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_changes" ADD CONSTRAINT "score_changes_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_pushes" ADD CONSTRAINT "portal_pushes_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "result_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

