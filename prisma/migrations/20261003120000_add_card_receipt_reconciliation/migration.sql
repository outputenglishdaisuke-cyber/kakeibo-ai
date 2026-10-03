-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('credit_card', 'cash', 'unknown');

-- CreateEnum
CREATE TYPE "ReconcileStatus" AS ENUM ('unmatched', 'matched', 'fallback_split', 'cash', 'unknown');

-- CreateEnum
CREATE TYPE "CashSource" AS ENUM ('confirmed', 'auto');

-- CreateEnum
CREATE TYPE "StoreMatchVerdict" AS ENUM ('same', 'different', 'undetermined');

-- CreateEnum
CREATE TYPE "StoreMatchSource" AS ENUM ('ai', 'user');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "autoCashExempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cashSource" "CashSource",
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "matchedCardId" TEXT,
ADD COLUMN     "matchedReceiptId" TEXT,
ADD COLUMN     "needsReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "receiptGroupId" TEXT,
ADD COLUMN     "reconcileStatus" "ReconcileStatus" NOT NULL DEFAULT 'unmatched',
ADD COLUMN     "rejectedCardIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "StoreMatchJudgement" (
    "id" TEXT NOT NULL,
    "cardName" TEXT NOT NULL,
    "receiptName" TEXT NOT NULL,
    "cardSample" TEXT NOT NULL,
    "receiptSample" TEXT NOT NULL,
    "verdict" "StoreMatchVerdict" NOT NULL,
    "source" "StoreMatchSource" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "merchant" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreMatchJudgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreMatchJudgement_cardName_receiptName_key" ON "StoreMatchJudgement"("cardName", "receiptName");

-- CreateIndex
CREATE INDEX "Transaction_reconcileStatus_idx" ON "Transaction"("reconcileStatus");

-- CreateIndex
CREATE INDEX "Transaction_matchedCardId_idx" ON "Transaction"("matchedCardId");

-- CreateIndex
CREATE INDEX "Transaction_receiptGroupId_idx" ON "Transaction"("receiptGroupId");

