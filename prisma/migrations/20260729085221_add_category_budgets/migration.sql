-- CreateTable
CREATE TABLE "CategoryBudget" (
    "categoryId" TEXT NOT NULL,
    "targetAmount" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryBudget_pkey" PRIMARY KEY ("categoryId")
);

-- CreateIndex
CREATE INDEX "CategoryBudget_sortOrder_idx" ON "CategoryBudget"("sortOrder");

-- AddForeignKey
ALTER TABLE "CategoryBudget" ADD CONSTRAINT "CategoryBudget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed monthly budgets for existing default categories.
-- 家賃は予算比較対象外のため意図的に含めない。
INSERT INTO "CategoryBudget" (
    "categoryId",
    "targetAmount",
    "sortOrder",
    "updatedAt"
)
SELECT
    "id",
    CASE "name"
        WHEN '食費' THEN 50000
        WHEN '外食費' THEN 20000
        WHEN '日用品' THEN 15000
        WHEN '趣味・嗜好・娯楽' THEN 20000
        WHEN '特別費' THEN 30000
        WHEN '電気' THEN 6000
        WHEN 'ガス' THEN 4000
        WHEN '水道' THEN 3000
    END,
    CASE "name"
        WHEN '食費' THEN 1
        WHEN '外食費' THEN 2
        WHEN '日用品' THEN 3
        WHEN '趣味・嗜好・娯楽' THEN 4
        WHEN '特別費' THEN 5
        WHEN '電気' THEN 6
        WHEN 'ガス' THEN 7
        WHEN '水道' THEN 8
    END,
    CURRENT_TIMESTAMP
FROM "Category"
WHERE "name" IN (
    '食費',
    '外食費',
    '日用品',
    '趣味・嗜好・娯楽',
    '特別費',
    '電気',
    'ガス',
    '水道'
);
