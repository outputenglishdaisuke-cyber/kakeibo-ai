BEGIN;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "excludedReason" TEXT,
ADD COLUMN "corrections" JSONB;

COMMIT;
