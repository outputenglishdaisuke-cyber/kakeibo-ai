import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureDefaultBudgets } from "@/lib/default-budgets";
import { getMonthRange, getMonthKey } from "@/lib/utils";

const MONTH_RE = /^\d{4}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    const requestedMonth = req.nextUrl.searchParams.get("month");
    const month =
      requestedMonth && MONTH_RE.test(requestedMonth)
        ? requestedMonth
        : getMonthKey(new Date());
    const { start, end } = getMonthRange(month);

    // 家賃には予算行を作らないため、この取得結果にも含まれない。
    const budgets = await ensureDefaultBudgets();
    const categoryIds = budgets.map((budget) => budget.categoryId);

    const actuals = await prisma.transaction.groupBy({
      by: ["categoryId"],
      where: {
        confirmed: true,
        date: { gte: start, lte: end },
        categoryId: { in: categoryIds },
      },
      _sum: { amount: true },
    });
    const actualByCategory = new Map(
      actuals.map((row) => [row.categoryId, row._sum.amount ?? 0])
    );

    const rows = budgets.map((budget) => {
      const actualAmount = actualByCategory.get(budget.categoryId) ?? 0;
      return {
        categoryId: budget.categoryId,
        categoryName: budget.category.name,
        color: budget.category.color,
        targetAmount: budget.targetAmount,
        actualAmount,
        difference: actualAmount - budget.targetAmount,
      };
    });

    const totals = rows.reduce(
      (sum, row) => ({
        targetAmount: sum.targetAmount + row.targetAmount,
        actualAmount: sum.actualAmount + row.actualAmount,
      }),
      { targetAmount: 0, actualAmount: 0 }
    );

    return NextResponse.json({
      month,
      rows,
      totals: {
        ...totals,
        difference: totals.actualAmount - totals.targetAmount,
      },
    });
  } catch (error) {
    console.error("[/api/budgets] GET failed:", error);
    return NextResponse.json(
      { error: "予算実績の取得に失敗しました" },
      { status: 500 }
    );
  }
}

