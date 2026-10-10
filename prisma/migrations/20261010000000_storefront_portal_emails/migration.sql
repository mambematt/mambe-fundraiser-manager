-- AlterTable
ALTER TABLE "fundraisers" ADD COLUMN     "banner_state" TEXT NOT NULL DEFAULT 'off',
ADD COLUMN     "banner_team_name" TEXT,
ADD COLUMN     "banner_written_at" TIMESTAMPTZ(3),
ADD COLUMN     "emails_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "short_link_redirect_id" TEXT,
ADD COLUMN     "short_link_slug" TEXT,
ADD COLUMN     "short_link_written_at" TIMESTAMPTZ(3),
ADD COLUMN     "storefront_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "storefront_error" TEXT,
ADD COLUMN     "storefront_error_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "communications" ADD COLUMN     "last_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN     "reminder_number" INTEGER,
ADD COLUMN     "sent_by" TEXT;

-- CreateTable
CREATE TABLE "portal_visits" (
    "id" SERIAL NOT NULL,
    "organizer_id" INTEGER NOT NULL,
    "fundraiser_id" INTEGER,
    "visited_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_events" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_limit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portal_visits_organizer_id_idx" ON "portal_visits"("organizer_id");

-- CreateIndex
CREATE INDEX "portal_visits_fundraiser_id_idx" ON "portal_visits"("fundraiser_id");

-- CreateIndex
CREATE INDEX "rate_limit_events_key_created_at_idx" ON "rate_limit_events"("key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fundraisers_short_link_slug_key" ON "fundraisers"("short_link_slug");

