-- 途中で失敗したときに一部だけ適用された状態を残さない
BEGIN;

-- CreateEnum
CREATE TYPE "UnmatchedReason" AS ENUM ('no_csv_coverage', 'no_candidate');

-- DropIndex（20260729191437 で UNIQUE 制約として作成されているため、制約として削除する）
ALTER TABLE "Transaction" DROP CONSTRAINT "Transaction_date_description_amount_key";

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "dupIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "unmatchedReason" "UnmatchedReason";

-- CreateTable
CREATE TABLE "CardImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" TEXT,
    "format" TEXT,
    "paymentMonth" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "coverageStart" TIMESTAMP(3),
    "coverageEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Transaction_importBatchId_idx" ON "Transaction"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_date_description_amount_dupIndex_key" ON "Transaction"("date", "description", "amount", "dupIndex");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "CardImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;

