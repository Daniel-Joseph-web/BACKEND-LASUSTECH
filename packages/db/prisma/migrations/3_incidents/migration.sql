-- Hall incident dockets (invigilator malpractice / technical reports).
--
-- Hand-written migration, matching the style of 1_integrity and
-- 2_identity_hardening. `prisma migrate dev` must not be allowed to drop the
-- explicit grant at the bottom.

CREATE TYPE "IncidentCategory" AS ENUM ('MALPRACTICE', 'TECHNICAL', 'INFRASTRUCTURE', 'MEDICAL', 'CONDUCT');
CREATE TYPE "IncidentSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "IncidentStatus" AS ENUM ('UNDER_REVIEW', 'ESCALATED', 'RESOLVED');

CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "reference_no" TEXT NOT NULL,
    "sitting_id" UUID,
    "attempt_id" UUID,
    "reported_by" UUID NOT NULL,
    "category" "IncidentCategory" NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'UNDER_REVIEW',
    "candidate_name" TEXT,
    "matric_no" TEXT,
    "seat_label" TEXT,
    "hall" TEXT,
    "description" TEXT NOT NULL,
    "action_taken" TEXT,
    "docket_confiscated" BOOLEAN NOT NULL DEFAULT false,
    "resolution_note" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incidents_reference_no_key" ON "incidents"("reference_no");
CREATE INDEX "incidents_created_at_idx" ON "incidents"("created_at");
CREATE INDEX "incidents_status_severity_idx" ON "incidents"("status", "severity");
CREATE INDEX "incidents_sitting_id_idx" ON "incidents"("sitting_id");
CREATE INDEX "incidents_reported_by_created_at_idx" ON "incidents"("reported_by", "created_at");

ALTER TABLE "incidents" ADD CONSTRAINT "incidents_sitting_id_fkey"
  FOREIGN KEY ("sitting_id") REFERENCES "sittings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_attempt_id_fkey"
  FOREIGN KEY ("attempt_id") REFERENCES "attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_reported_by_fkey"
  FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- cbt_app is not the table owner; least privilege is granted explicitly here
-- rather than relying on default privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "incidents" TO cbt_app;
