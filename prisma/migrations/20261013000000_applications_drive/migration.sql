-- Session 6: applications, Drive folders, optional product/dates in Setup.

-- Product and dates are optional until launch (a fundraiser created from an
-- application has neither yet). Launch requires both (app/lib/launch-gate.ts).
ALTER TABLE "fundraisers" ALTER COLUMN "product_id" DROP NOT NULL;
ALTER TABLE "fundraisers" ALTER COLUMN "start_date" DROP NOT NULL;
ALTER TABLE "fundraisers" ALTER COLUMN "end_date" DROP NOT NULL;
ALTER TABLE "fundraisers" ALTER COLUMN "window_start" DROP NOT NULL;
ALTER TABLE "fundraisers" ALTER COLUMN "window_end" DROP NOT NULL;

-- Dates and window are set together or not at all.
ALTER TABLE "fundraisers" ADD CONSTRAINT "fundraisers_dates_together" CHECK (
  ("start_date" IS NULL) = ("end_date" IS NULL)
  AND ("start_date" IS NULL) = ("window_start" IS NULL)
  AND ("start_date" IS NULL) = ("window_end" IS NULL)
);

-- Same overlap rule as before; a fundraiser without a product or window
-- can't overlap anything (an empty window would otherwise be unbounded).
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
  WHERE ("status" <> 'declined' AND "product_id" IS NOT NULL AND "window_start" IS NOT NULL);

-- Drive folders, by stored ID.
ALTER TABLE "fundraisers" ADD COLUMN "drive_assets_folder_id" TEXT;
ALTER TABLE "fundraisers" ADD COLUMN "drive_internal_folder_id" TEXT;
ALTER TABLE "fundraisers" ADD COLUMN "drive_error" TEXT;
ALTER TABLE "fundraisers" ADD COLUMN "drive_error_at" TIMESTAMPTZ(3);
ALTER TABLE "teams" ADD COLUMN "drive_artwork_folder_id" TEXT;

-- Applications.
ALTER TABLE "applications" ADD COLUMN "notes" TEXT;
ALTER TABLE "applications" ADD COLUMN "decline_reason" TEXT;
ALTER TABLE "applications" ADD COLUMN "reviewed_by" TEXT;
ALTER TABLE "applications" ADD COLUMN "reviewed_at" TIMESTAMPTZ(3);

CREATE TABLE "application_emails" (
    "id" SERIAL NOT NULL,
    "application_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "application_emails_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "application_emails_application_id_kind_key" ON "application_emails"("application_id", "kind");
CREATE INDEX "application_emails_status_idx" ON "application_emails"("status");
ALTER TABLE "application_emails" ADD CONSTRAINT "application_emails_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
