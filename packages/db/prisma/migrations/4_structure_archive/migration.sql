-- Archive flag for academic structure.
--
-- Colleges and courses already carry `active`; departments and programmes did
-- not, so a discontinued department or programme could only be deleted, which
-- the API refuses while anything still references it. Hand-written to match
-- the style of 1_integrity through 3_incidents. Existing table grants cover
-- the new columns, so no GRANT is needed here.

ALTER TABLE "departments" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "programmes"  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
