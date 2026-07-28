/**
 * 複数の取引をルール → AI の順で分類する共通ロジック。
 */
import { prisma } from "@/lib/prisma";
import { classifyTransactions } from "@/lib/classifiers";
import { ensureDefaultCategories } from "@/lib/default-categories";
import type { ParsedTransaction } from "@/types";

export type ClassifiedTransaction = ParsedTransaction & {
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
};

export async function classifyParsedTransactions(
  transactions: ParsedTransaction[],
  options: { autoClassify?: boolean } = { autoClassify: true }
): Promise<ClassifiedTransaction[]> {
  const categories = await ensureDefaultCategories();
  const categoryIdSet = new Set(categories.map((c) => c.id));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const rules = await prisma.rule.findMany({ include: { category: true } });

  const categorized: ClassifiedTransaction[] = transactions.map((tx) => {
    // Vision OCR 等で既にカテゴリが付いている場合は優先
    let presetId =
      tx.categoryId && categoryIdSet.has(tx.categoryId) ? tx.categoryId : null;
    if (!presetId && tx.categoryName) {
      const byName = categories.find((c) => c.name === tx.categoryName);
      if (byName) presetId = byName.id;
    }
    if (presetId) {
      const cat = categoryById.get(presetId);
      return {
        ...tx,
        categoryId: presetId,
        categoryName: cat?.name ?? tx.categoryName ?? null,
        categoryColor: cat?.color ?? tx.categoryColor ?? null,
      };
    }

    const matched = rules
      .filter((r) =>
        tx.description.toLowerCase().includes(r.keyword.toLowerCase())
      )
      .sort((a, b) => b.priority - a.priority)[0];

    const categoryId =
      matched?.categoryId && categoryIdSet.has(matched.categoryId)
        ? matched.categoryId
        : null;
    const cat = categoryId ? categoryById.get(categoryId) : null;

    return {
      ...tx,
      categoryId,
      categoryName: cat?.name ?? null,
      categoryColor: cat?.color ?? null,
    };
  });

  if (!options.autoClassify || categories.length === 0) {
    return categorized;
  }

  const uncategorizedIndices = categorized
    .map((tx, i) => (tx.categoryId === null ? i : -1))
    .filter((i) => i !== -1);

  const CHUNK = 30;
  for (let offset = 0; offset < uncategorizedIndices.length; offset += CHUNK) {
    const chunkIndices = uncategorizedIndices.slice(offset, offset + CHUNK);
    const chunk = chunkIndices.map((i) => categorized[i]);
    const results = await classifyTransactions(
      chunk.map((tx) => ({ description: tx.description, amount: tx.amount })),
      categories.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        description: c.description,
        icon: c.icon,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }))
    );

    results.forEach((result, j) => {
      const idx = chunkIndices[j];
      let id =
        result.suggestedCategoryId &&
        categoryIdSet.has(result.suggestedCategoryId)
          ? result.suggestedCategoryId
          : null;

      // ID が不正でも名前が一致すれば採用
      if (!id && result.suggestedCategoryName) {
        const byName = categories.find(
          (c) => c.name === result.suggestedCategoryName
        );
        if (byName) id = byName.id;
      }

      if (id) {
        const cat = categoryById.get(id);
        categorized[idx].categoryId = id;
        categorized[idx].categoryName = cat?.name ?? result.suggestedCategoryName;
        categorized[idx].categoryColor = cat?.color ?? null;
      }
    });
  }

  return categorized;
}
