import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMonthRange } from "@/lib/utils";

/**
 * 月別・カテゴリ別の集計データを返す。
 * ?month=YYYY-MM を指定して単月取得。
 * ?months=6 などで直近N ヶ月の推移データを取得。
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const month = searchParams.get("month");
  const monthsParam = searchParams.get("months");

  if (month) {
    // 単月の詳細集計
    const { start, end } = getMonthRange(month);
    const transactions = await prisma.transaction.findMany({
      where: { date: { gte: start, lte: end }, confirmed: true },
      include: { category: true },
    });

    const total = transactions.reduce((sum: number, tx: { amount: number }) => sum + tx.amount, 0);

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
    // 直近N ヶ月の推移
    const n = Math.min(parseInt(monthsParam, 10) || 6, 24);
    const now = new Date();
    const months: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      );
    }

    const results = await Promise.all(
      months.map(async (m) => {
        const { start, end } = getMonthRange(m);
        const txs = await prisma.transaction.findMany({
          where: { date: { gte: start, lte: end }, confirmed: true },
        });
        return {
          month: m,
          total: txs.reduce((s: number, tx: { amount: number }) => s + tx.amount, 0),
        };
      })
    );

    return NextResponse.json({ trend: results });
  }

  return NextResponse.json({ error: "month または months パラメータが必要です" }, { status: 400 });
}
