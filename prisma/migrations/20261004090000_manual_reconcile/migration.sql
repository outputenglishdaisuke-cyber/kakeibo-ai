BEGIN;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "linkId" TEXT;

-- CreateTable
CREATE TABLE "ReconcileOperation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'user',
    "summary" TEXT NOT NULL,
    "rowIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "changes" JSONB NOT NULL,
    "createdRowIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ruleId" TEXT,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconcileOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardOnlyRule" (
    "id" TEXT NOT NULL,
    "storeKey" TEXT NOT NULL,
    "storeSample" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardOnlyRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconcileOperation_createdAt_idx" ON "ReconcileOperation"("createdAt");

-- CreateIndex
CREATE INDEX "CardOnlyRule_storeKey_idx" ON "CardOnlyRule"("storeKey");

-- CreateIndex
CREATE INDEX "Transaction_linkId_idx" ON "Transaction"("linkId");

-- AddForeignKey
ALTER TABLE "CardOnlyRule" ADD CONSTRAINT "CardOnlyRule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
