/**
 * 明細一覧へのフィルター付き URL を組み立てる。
 */
export function buildTransactionsFilterUrl(options: {
  month: string;
  /** カテゴリ ID。未分類は null または "uncategorized" */
  categoryId?: string | null;
  /** カテゴリ名（ID が無い場合のフォールバック。URL には name を入れる） */
  categoryName?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("month", options.month);

  if (options.categoryId === null || options.categoryId === "uncategorized") {
    params.set("categories", "uncategorized");
  } else if (options.categoryId) {
    params.set("categories", options.categoryId);
  } else if (options.categoryName) {
    const name = options.categoryName.trim();
    if (!name || name === "未分類") {
      params.set("categories", "uncategorized");
    } else {
      // 互換: category クエリでも受け取れるようにする
      params.set("category", name);
    }
  }

  return `/transactions?${params.toString()}`;
}
