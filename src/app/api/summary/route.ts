import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getMonthRange,
  listMonthKeys,
  recentMonthRange,
} from "@/lib/utils";
import type { CategoryMonthMatrix, CategoryMonthMatrixRow } from "@/types";

const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_RANGE_MONTHS = 120;

/**
 * 月別・カテゴリ別の集計データを返す。
 * - ?month=YYYY-MM … 単月のカテゴリ内訳
 * - ?months=N … 直近 N ヶ月の合計推移（既存）
 * - ?from=YYYY-MM&to=YYYY-MM … カテゴリ×月のマトリクス
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const month = searchParams.get("month");
  const monthsParam = searchParams.get("months");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  if (fromParam || toParam) {
    if (!fromParam || !toParam || !MONTH_RE.test(fromParam) || !MONTH_RE.test(toParam)) {
      return NextResponse.json(
        { error: "from / to は YYYY-MM 形式で両方指定してください" },
        { status: 400 }
      );
    }
    if (fromParam > toParam) {
      return NextResponse.json(
        { error: "from は to 以前の月を指定してください" },
        { status: 400 }
      );
    }

    const months = listMonthKeys(fromParam, toParam);
    if (months.length === 0 || months.length > MAX_RANGE_MONTHS) {
      return NextResponse.json(
        { error: `期間は1〜${MAX_RANGE_MONTHS}ヶ月の範囲で指定してください` },
        { status: 400 }
      );
    }

    const matrix = await buildCategoryMonthMatrix(fromParam, toParam, months);
    return NextResponse.json(matrix);
  }

  if (month) {
    const { start, end } = getMonthRange(month);
    const transactions = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end }, confirmed: true },
      include: { category: true },
    });

    const total = transactions.reduce(
      (sum: number, tx: { amount: number }) => sum + tx.amount,
      0
    );

    const byCategory: Record<
      string,
      { categoryId: string | null; categoryName: string; color: string; total: number }
    > = {};

    for (const tx of transactions) {
      const key = tx.categoryId ?? "__uncategorized__";
      if (!byCategory[key]) {
        byCategory[key] = {
          categoryId: tx.categoryId,
          categoryName: tx.category?.name ?? "未分類",
          color: tx.category?.color ?? "#94a3b8",
          total: 0,
        };
      }
      byCategory[key].total += tx.amount;
    }

    const categories = Object.values(byCategory).map((c) => ({
      ...c,
      percentage: total > 0 ? Math.round((c.total / total) * 1000) / 10 : 0,
    }));

    return NextResponse.json({ month, total, categories });
  }

  if (monthsParam) {
    const n = Math.min(parseInt(monthsParam, 10) || 6, 36);
    const { from, to } = recentMonthRange(n);
    const months = listMonthKeys(from, to);

    const { start } = getMonthRange(from);
    const { end } = getMonthRange(to);

    // 範囲内を1クエリで取得して月別に集計
    const txs = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end }, confirmed: true },
      select: { date: true, amount: true },
    });

    const byMonth = new Map<string, number>();
    for (const m of months) byMonth.set(m, 0);
    for (const tx of txs) {
      const key = `${tx.date.getFullYear()}-${String(tx.date.getMonth() + 1).padStart(2, "0")}`;
      if (byMonth.has(key)) {
        byMonth.set(key, (byMonth.get(key) ?? 0) + tx.amount);
      }
    }

    return NextResponse.json({
      trend: months.map((m) => ({ month: m, total: byMonth.get(m) ?? 0 })),
    });
  }

  return NextResponse.json(
    { error: "month / months / from&to のいずれかのパラメータが必要です" },
    { status: 400 }
  );
}

async function buildCategoryMonthMatrix(
  from: string,
  to: string,
  months: string[]
): Promise<CategoryMonthMatrix> {
  const { start } = getMonthRange(from);
  const { end } = getMonthRange(to);

  const [allCategories, txs] = await Promise.all([
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    prisma.transaction.findMany({
      where: { date: { gte: start, lte: end }, confirmed: true },
      select: {
        date: true,
        amount: true,
        categoryId: true,
      },
    }),
  ]);

  const monthIndex = new Map(months.map((m, i) => [m, i]));

  // key = categoryId or __uncategorized__
  const amountsByCat = new Map<string, number[]>();
  const ensureRow = (key: string) => {
    if (!amountsByCat.has(key)) {
      amountsByCat.set(key, Array(months.length).fill(0));
    }
    return amountsByCat.get(key)!;
  };

  // 登録済みカテゴリはゼロ埋め行を先に用意
  for (const c of allCategories) {
    ensureRow(c.id);
  }
  ensureRow("__uncategorized__");

  for (const tx of txs) {
    const m = `${tx.date.getFullYear()}-${String(tx.date.getMonth() + 1).padStart(2, "0")}`;
    const mi = monthIndex.get(m);
    if (mi === undefined) continue;
    const key = tx.categoryId ?? "__uncategorized__";
    const row = ensureRow(key);
    row[mi] += tx.amount;
  }

  const categories: CategoryMonthMatrixRow[] = [];

  for (const c of allCategories) {
    const amounts = amountsByCat.get(c.id) ?? Array(months.length).fill(0);
    categories.push({
      categoryId: c.id,
      categoryName: c.name,
      color: c.color,
      amounts,
      rowTotal: amounts.reduce((s, n) => s + n, 0),
    });
  }

  const uncatAmounts =
    amountsByCat.get("__uncategorized__") ?? Array(months.length).fill(0);
  categories.push({
    categoryId: null,
    categoryName: "未分類",
    color: "#94a3b8",
    amounts: uncatAmounts,
    rowTotal: uncatAmounts.reduce((s, n) => s + n, 0),
  });

  const monthTotals = months.map((_, i) =>
    categories.reduce((s, row) => s + row.amounts[i], 0)
  );
  const grandTotal = monthTotals.reduce((s, n) => s + n, 0);

  return {
    from,
    to,
    months,
    categories,
    monthTotals,
    grandTotal,
  };
}
