-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Transaction_archived_idx" ON "Transaction"("archived");
