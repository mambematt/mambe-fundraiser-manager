-- AlterTable
ALTER TABLE "fundraisers" ADD COLUMN     "settlement_error" TEXT,
ADD COLUMN     "settlement_error_at" TIMESTAMPTZ(3),
ADD COLUMN     "settlement_repull_orders" INTEGER,
ADD COLUMN     "settlement_repulled_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "payouts" ADD COLUMN     "crosscheck_app_units" INTEGER,
ADD COLUMN     "crosscheck_at" TIMESTAMPTZ(3),
ADD COLUMN     "crosscheck_by" TEXT,
ADD COLUMN     "crosscheck_note" TEXT,
ADD COLUMN     "crosscheck_shopify_units" INTEGER,
ADD COLUMN     "final_cents" INTEGER,
ADD COLUMN     "individual_payee_confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "individual_payee_confirmed_by" TEXT,
ADD COLUMN     "individual_payee_note" TEXT,
ADD COLUMN     "paid_amount_cents" INTEGER,
ADD COLUMN     "paid_by" TEXT,
ADD COLUMN     "paid_note" TEXT;

-- CreateTable
CREATE TABLE "payout_changes" (
    "id" SERIAL NOT NULL,
    "payout_id" INTEGER NOT NULL,
    "line_item_id" INTEGER NOT NULL,
    "order_name" TEXT NOT NULL,
    "units_counted" INTEGER NOT NULL,
    "units_now" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by" TEXT,

    CONSTRAINT "payout_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_changes_payout_id_idx" ON "payout_changes"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "payout_changes_line_item_id_units_now_key" ON "payout_changes"("line_item_id", "units_now");

-- AddForeignKey
ALTER TABLE "payout_changes" ADD CONSTRAINT "payout_changes_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Money sanity: a payout's figures can't go negative except via adjustments.
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_units_not_negative" CHECK ("qualifying_units" >= 0 AND "amount_cents" >= 0);
