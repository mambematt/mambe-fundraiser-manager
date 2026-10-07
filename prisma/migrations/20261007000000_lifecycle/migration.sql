-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "reason" TEXT;

-- CreateTable
CREATE TABLE "job_runs" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "details" JSONB,
    "error" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_runs_name_started_at_idx" ON "job_runs"("name", "started_at");


-- ---------------------------------------------------------------------------
-- Owner decision (2026-10-07): a cancelled fundraiser still holds its window
-- up to the moment it was cancelled, so nothing may overlap that part.
-- Declined fundraisers hold nothing. The effective end is clamped so a
-- fundraiser cancelled before it started holds an empty range.
-- ---------------------------------------------------------------------------
ALTER TABLE "fundraisers" DROP CONSTRAINT "fundraisers_no_overlap";

ALTER TABLE "fundraisers"
  ADD CONSTRAINT "fundraisers_no_overlap"
  EXCLUDE USING gist (
    "product_id" WITH =,
    tstzrange(
      "window_start",
      GREATEST("window_start", LEAST("window_end", COALESCE("cancelled_at", "window_end"))),
      '[)'
    ) WITH &&
  )
  WHERE ("status" <> 'declined');
