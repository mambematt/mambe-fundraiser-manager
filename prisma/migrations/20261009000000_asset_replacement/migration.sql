-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "replaced_at" TIMESTAMPTZ(3),
ADD COLUMN     "replaced_by_id" INTEGER;

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

