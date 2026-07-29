import { prisma } from "@/lib/prisma";
import { ensureDefaultCategories } from "@/lib/default-categories";

export const DEFAULT_CATEGORY_BUDGETS = [
  { categoryName: "食費", targetAmount: 50_000, sortOrder: 1 },
  { categoryName: "外食費", targetAmount: 20_000, sortOrder: 2 },
  { categoryName: "日用品", targetAmount: 15_000, sortOrder: 3 },
  { categoryName: "趣味・嗜好・娯楽", targetAmount: 20_000, sortOrder: 4 },
  { categoryName: "特別費", targetAmount: 30_000, sortOrder: 5 },
  { categoryName: "電気", targetAmount: 6_000, sortOrder: 6 },
  { categoryName: "ガス", targetAmount: 4_000, sortOrder: 7 },
  { categoryName: "水道", targetAmount: 3_000, sortOrder: 8 },
] as const;

/**
 * 未登録の予算だけを初期値で作成する。
 * 既存値は上書きしないため、将来ユーザーが変更した値を保持できる。
 */
export async function ensureDefaultBudgets() {
  const categories = await ensureDefaultCategories();
  const categoryByName = new Map(categories.map((c) => [c.name, c]));

  await prisma.categoryBudget.createMany({
    data: DEFAULT_CATEGORY_BUDGETS.flatMap((budget) => {
      const category = categoryByName.get(budget.categoryName);
      return category
        ? [
            {
              categoryId: category.id,
              targetAmount: budget.targetAmount,
              sortOrder: budget.sortOrder,
            },
          ]
        : [];
    }),
    skipDuplicates: true,
  });

  return prisma.categoryBudget.findMany({
    include: { category: true },
    orderBy: [{ sortOrder: "asc" }, { category: { name: "asc" } }],
  });
}

