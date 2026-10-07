-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "city" TEXT,
    "state" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "drive_folder_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" SERIAL NOT NULL,
    "organization_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sport" TEXT,
    "level" TEXT,
    "drive_folder_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fundraiser_organizers" (
    "fundraiser_id" INTEGER NOT NULL,
    "organizer_id" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "fundraiser_organizers_pkey" PRIMARY KEY ("fundraiser_id","organizer_id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "shopify_product_id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "team_id" INTEGER,
    "design_notes" TEXT,
    "drive_folder_id" TEXT,
    "last_synced_at" TIMESTAMPTZ(3),
    "backfilled_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fundraisers" (
    "id" SERIAL NOT NULL,
    "public_code" TEXT NOT NULL,
    "team_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "season_label" TEXT,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "payout_rate_cents" INTEGER NOT NULL DEFAULT 2500,
    "status" TEXT NOT NULL DEFAULT 'setup',
    "organizer_info_received_at" TIMESTAMPTZ(3),
    "organizer_info_received_by" TEXT,
    "artwork_approved_at" TIMESTAMPTZ(3),
    "artwork_approved_by" TEXT,
    "product_ready_at" TIMESTAMPTZ(3),
    "product_ready_by" TEXT,
    "assets_uploaded_at" TIMESTAMPTZ(3),
    "assets_uploaded_by" TEXT,
    "drive_folders_created_at" TIMESTAMPTZ(3),
    "drive_folders_created_by" TEXT,
    "launch_package_reviewed_at" TIMESTAMPTZ(3),
    "launch_package_reviewed_by" TEXT,
    "waiting_on_organizer_since" TIMESTAMPTZ(3),
    "short_url" TEXT,
    "paypal_payee_email" TEXT,
    "drive_folder_id" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fundraisers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" SERIAL NOT NULL,
    "raw_submission" JSONB NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "organization_name" TEXT,
    "team_name" TEXT,
    "role" TEXT,
    "city" TEXT,
    "state" TEXT,
    "rough_timing" TEXT,
    "has_logo" BOOLEAN,
    "status" TEXT NOT NULL DEFAULT 'new',
    "converted_fundraiser_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shopify_orders" (
    "id" SERIAL NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL,
    "financial_status" TEXT NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "source_name" TEXT,
    "source" TEXT NOT NULL,
    "discount_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "has_money_only_refund" BOOLEAN NOT NULL DEFAULT false,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "shopify_updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shopify_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_items" (
    "id" SERIAL NOT NULL,
    "shopify_line_item_id" TEXT NOT NULL,
    "order_id" INTEGER NOT NULL,
    "shopify_product_id" TEXT NOT NULL,
    "shopify_variant_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "refunded_quantity" INTEGER NOT NULL DEFAULT 0,
    "current_quantity" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_cents" INTEGER,
    "cost_approximate" BOOLEAN NOT NULL DEFAULT false,
    "attributed_fundraiser_id" INTEGER,
    "qualifying_units" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL DEFAULT 'pending',
    "review_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "review_reason" TEXT,
    "attributed_at" TIMESTAMPTZ(3),
    "admin_decision" TEXT,
    "admin_decision_note" TEXT,
    "admin_decision_by" TEXT,
    "admin_decision_at" TIMESTAMPTZ(3),
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" SERIAL NOT NULL,
    "fundraiser_id" INTEGER NOT NULL,
    "rate_cents" INTEGER NOT NULL,
    "qualifying_units" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "calculated_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "approved_by" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "method" TEXT,
    "paypal_reference" TEXT,
    "payee_email" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_lines" (
    "id" SERIAL NOT NULL,
    "payout_id" INTEGER NOT NULL,
    "line_item_id" INTEGER NOT NULL,
    "units_counted" INTEGER NOT NULL,

    CONSTRAINT "payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_adjustments" (
    "id" SERIAL NOT NULL,
    "payout_id" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "effective_date" DATE NOT NULL,
    "admin_note" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assets" (
    "id" SERIAL NOT NULL,
    "fundraiser_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "drive_file_id" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communications" (
    "id" SERIAL NOT NULL,
    "fundraiser_id" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" SERIAL NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "resource_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_login_tokens" (
    "id" SERIAL NOT NULL,
    "organizer_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_login_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_sessions" (
    "id" SERIAL NOT NULL,
    "organizer_id" INTEGER NOT NULL,
    "session_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portal_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teams_organization_id_idx" ON "teams"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizers_email_key" ON "organizers"("email");

-- CreateIndex
CREATE INDEX "fundraiser_organizers_organizer_id_idx" ON "fundraiser_organizers"("organizer_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_shopify_product_id_key" ON "products"("shopify_product_id");

-- CreateIndex
CREATE INDEX "products_team_id_idx" ON "products"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "fundraisers_public_code_key" ON "fundraisers"("public_code");

-- CreateIndex
CREATE INDEX "fundraisers_status_idx" ON "fundraisers"("status");

-- CreateIndex
CREATE INDEX "fundraisers_product_id_idx" ON "fundraisers"("product_id");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "shopify_orders_shopify_order_id_key" ON "shopify_orders"("shopify_order_id");

-- CreateIndex
CREATE INDEX "shopify_orders_processed_at_idx" ON "shopify_orders"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_line_items_shopify_line_item_id_key" ON "order_line_items"("shopify_line_item_id");

-- CreateIndex
CREATE INDEX "order_line_items_shopify_product_id_idx" ON "order_line_items"("shopify_product_id");

-- CreateIndex
CREATE INDEX "order_line_items_attributed_fundraiser_id_idx" ON "order_line_items"("attributed_fundraiser_id");

-- CreateIndex
CREATE INDEX "order_line_items_order_id_idx" ON "order_line_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_fundraiser_id_key" ON "payouts"("fundraiser_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_lines_line_item_id_key" ON "payout_lines"("line_item_id");

-- CreateIndex
CREATE INDEX "payout_lines_payout_id_idx" ON "payout_lines"("payout_id");

-- CreateIndex
CREATE INDEX "payout_adjustments_payout_id_idx" ON "payout_adjustments"("payout_id");

-- CreateIndex
CREATE INDEX "assets_fundraiser_id_idx" ON "assets"("fundraiser_id");

-- CreateIndex
CREATE INDEX "communications_fundraiser_id_idx" ON "communications"("fundraiser_id");

-- CreateIndex
CREATE INDEX "communications_status_scheduled_for_idx" ON "communications"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_webhook_id_key" ON "webhook_events"("webhook_id");

-- CreateIndex
CREATE INDEX "webhook_events_status_idx" ON "webhook_events"("status");

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "portal_login_tokens_token_hash_key" ON "portal_login_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "portal_login_tokens_organizer_id_idx" ON "portal_login_tokens"("organizer_id");

-- CreateIndex
CREATE UNIQUE INDEX "portal_sessions_session_hash_key" ON "portal_sessions"("session_hash");

-- CreateIndex
CREATE INDEX "portal_sessions_organizer_id_idx" ON "portal_sessions"("organizer_id");

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fundraiser_organizers" ADD CONSTRAINT "fundraiser_organizers_fundraiser_id_fkey" FOREIGN KEY ("fundraiser_id") REFERENCES "fundraisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fundraiser_organizers" ADD CONSTRAINT "fundraiser_organizers_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fundraisers" ADD CONSTRAINT "fundraisers_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fundraisers" ADD CONSTRAINT "fundraisers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_converted_fundraiser_id_fkey" FOREIGN KEY ("converted_fundraiser_id") REFERENCES "fundraisers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "shopify_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_attributed_fundraiser_id_fkey" FOREIGN KEY ("attributed_fundraiser_id") REFERENCES "fundraisers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_fundraiser_id_fkey" FOREIGN KEY ("fundraiser_id") REFERENCES "fundraisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_lines" ADD CONSTRAINT "payout_lines_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_lines" ADD CONSTRAINT "payout_lines_line_item_id_fkey" FOREIGN KEY ("line_item_id") REFERENCES "order_line_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_adjustments" ADD CONSTRAINT "payout_adjustments_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_fundraiser_id_fkey" FOREIGN KEY ("fundraiser_id") REFERENCES "fundraisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communications" ADD CONSTRAINT "communications_fundraiser_id_fkey" FOREIGN KEY ("fundraiser_id") REFERENCES "fundraisers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_login_tokens" ADD CONSTRAINT "portal_login_tokens_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_sessions" ADD CONSTRAINT "portal_sessions_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "organizers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Rules Prisma can't express. Written by hand; see docs/SPEC.md.
-- ---------------------------------------------------------------------------

-- Sanity checks on fundraisers.
ALTER TABLE "fundraisers"
  ADD CONSTRAINT "fundraisers_dates_ordered" CHECK ("end_date" >= "start_date"),
  ADD CONSTRAINT "fundraisers_window_ordered" CHECK ("window_end" > "window_start"),
  ADD CONSTRAINT "fundraisers_rate_not_negative" CHECK ("payout_rate_cents" >= 0);

-- No two fundraisers on the same product may have overlapping windows,
-- unless one of them is declined or cancelled. Windows are half-open
-- [window_start, window_end), so one ending at Nov 1 07:00 UTC and the next
-- starting at Nov 1 07:00 UTC do not overlap.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "fundraisers"
  ADD CONSTRAINT "fundraisers_no_overlap"
  EXCLUDE USING gist (
    "product_id" WITH =,
    tstzrange("window_start", "window_end", '[)') WITH &&
  )
  WHERE ("status" NOT IN ('declined', 'cancelled'));

-- Organizer emails are stored lowercase.
ALTER TABLE "organizers"
  ADD CONSTRAINT "organizers_email_lowercase" CHECK ("email" = lower("email"));

-- Line quantities can't go negative.
ALTER TABLE "order_line_items"
  ADD CONSTRAINT "order_line_items_quantities_valid" CHECK (
    "quantity" >= 0 AND "refunded_quantity" >= 0 AND "current_quantity" >= 0
    AND "qualifying_units" >= 0
  );

-- audit_log is append-only.
CREATE FUNCTION audit_log_refuse_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_change();

CREATE TRIGGER "audit_log_no_truncate"
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_refuse_change();
