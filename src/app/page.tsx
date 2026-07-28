"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExpensePieChart } from "@/components/charts/ExpensePieChart";
import { MonthlyTrendChart } from "@/components/charts/MonthlyTrendChart";
import { CategoryMonthlyMatrixTable } from "@/components/charts/CategoryMonthlyMatrixTable";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { formatCurrency, getMonthKey } from "@/lib/utils";
import { buildTransactionsFilterUrl } from "@/lib/transactions-url";
import type { CategorySummary } from "@/types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SummaryData {
  month: string;
  total: number;
  categories: CategorySummary[];
}

interface TrendData {
  trend: { month: string; total: number }[];
}

export default function DashboardPage() {
  const router = useRouter();
  const [currentMonth, setCurrentMonth] = useState<string>(
    getMonthKey(new Date())
  );
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [trend, setTrend] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [summaryRes, trendRes] = await Promise.all([
        fetch(`/api/summary?month=${currentMonth}`),
        fetch(`/api/summary?months=6`),
      ]);
      if (summaryRes.ok) setSummary(await summaryRes.json());
      if (trendRes.ok) setTrend(await trendRes.json());
    } finally {
      setLoading(false);
    }
  }, [currentMonth]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const changeMonth = (delta: number) => {
    const [y, m] = currentMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setCurrentMonth(getMonthKey(d));
  };

  const displayMonth = () => {
    const [y, m] = currentMonth.split("-");
    return `${y}年${parseInt(m)}月`;
  };

  const goToCategoryTransactions = useCallback(
    (cat: { categoryId?: string | null; categoryName?: string | null }) => {
      const url = buildTransactionsFilterUrl({
        month: currentMonth,
        categoryId: cat.categoryId ?? null,
        categoryName: cat.categoryName,
      });
      router.push(url);
    },
    [currentMonth, router]
  );

  const sortedCategories = useMemo(() => {
    if (!summary?.categories) return [];
    return [...summary.categories].sort((a, b) => b.total - a.total);
  }, [summary]);

  const topCategoryName =
    sortedCategories[0]?.categoryName?.trim() || "-";

  const widgets = useMemo(() => {
    if (loading) {
      return {
        "stat-total": (
          <Card className="h-full">
            <CardContent className="flex h-full items-center justify-center text-gray-400">
              …
            </CardContent>
          </Card>
        ),
        "stat-count": (
          <Card className="h-full">
            <CardContent className="flex h-full items-center justify-center text-gray-400">
              …
            </CardContent>
          </Card>
        ),
        "stat-top": (
          <Card className="h-full">
            <CardContent className="flex h-full items-center justify-center text-gray-400">
              …
            </CardContent>
          </Card>
        ),
        pie: (
          <Card className="h-full">
            <CardContent className="flex h-full items-center justify-center text-gray-400">
              読み込み中...
            </CardContent>
          </Card>
        ),
        trend: (
          <Card className="h-full">
            <CardContent className="flex h-full items-center justify-center text-gray-400">
              読み込み中...
            </CardContent>
          </Card>
        ),
        breakdown: (
          <Card className="h-full">
            <CardContent className="flex h-full items-center justify-center text-gray-400">
              読み込み中...
            </CardContent>
          </Card>
        ),
        matrix: <CategoryMonthlyMatrixTable className="h-full" />,
      };
    }

    return {
      "stat-total": (
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              月合計支出
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-indigo-600">
              {formatCurrency(summary?.total ?? 0)}
            </p>
          </CardContent>
        </Card>
      ),
      "stat-count": (
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              カテゴリ数
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-gray-900">
              {summary?.categories.length ?? 0}
            </p>
          </CardContent>
        </Card>
      ),
      "stat-top": (
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              最大支出カテゴリ
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sortedCategories[0] ? (
              <button
                type="button"
                className="truncate text-left text-xl font-bold text-gray-900 underline-offset-4 hover:underline"
                onClick={() => goToCategoryTransactions(sortedCategories[0])}
              >
                {topCategoryName}
              </button>
            ) : (
              <p className="text-xl font-bold text-gray-900 truncate">-</p>
            )}
          </CardContent>
        </Card>
      ),
      pie: (
        <Card className="h-full">
          <CardHeader>
            <CardTitle>カテゴリ別支出</CardTitle>
            <p className="text-xs text-gray-500">
              扇形をクリックすると明細一覧へ移動します
            </p>
          </CardHeader>
          <CardContent>
            <ExpensePieChart
              data={summary?.categories ?? []}
              onCategoryClick={goToCategoryTransactions}
            />
          </CardContent>
        </Card>
      ),
      trend: (
        <Card className="h-full">
          <CardHeader>
            <CardTitle>月次推移（直近6ヶ月）</CardTitle>
          </CardHeader>
          <CardContent>
            <MonthlyTrendChart data={trend?.trend ?? []} />
          </CardContent>
        </Card>
      ),
      breakdown: (
        <Card className="h-full">
          <CardHeader>
            <CardTitle>カテゴリ別内訳</CardTitle>
            <p className="text-xs text-gray-500">
              カテゴリ名をクリックすると明細一覧へ移動します
            </p>
          </CardHeader>
          <CardContent>
            {sortedCategories.length === 0 ? (
              <p className="py-8 text-center text-gray-400">データがありません</p>
            ) : (
              <div className="space-y-3">
                {sortedCategories.map((cat) => (
                  <div
                    key={cat.categoryId ?? "uncategorized"}
                    className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div
                        className="h-3 w-3 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: cat.color }}
                      />
                      <button
                        type="button"
                        className="truncate text-left text-sm text-gray-700 underline-offset-2 hover:text-indigo-700 hover:underline"
                        onClick={() => goToCategoryTransactions(cat)}
                      >
                        {cat.categoryName?.trim()
                          ? cat.categoryName
                          : "未分類"}
                      </button>
                    </div>
                    <div className="flex items-center gap-3 pl-6 sm:pl-0">
                      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-gray-100 sm:w-32 sm:flex-none">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${cat.percentage}%`,
                            backgroundColor: cat.color,
                          }}
                        />
                      </div>
                      <span className="w-10 flex-shrink-0 text-right text-xs text-gray-500">
                        {cat.percentage}%
                      </span>
                      <span className="w-24 flex-shrink-0 text-right text-sm font-medium sm:w-28">
                        {formatCurrency(cat.total)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ),
      matrix: <CategoryMonthlyMatrixTable className="h-full" />,
    };
  }, [
    loading,
    summary,
    trend,
    sortedCategories,
    topCategoryName,
    goToCategoryTransactions,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">ダッシュボード</h1>
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 sm:h-9 sm:w-9"
            onClick={() => changeMonth(-1)}
            aria-label="前月"
          >
            <ChevronLeft className="h-5 w-5 sm:h-4 sm:w-4" />
          </Button>
          <span className="min-w-[120px] text-center text-base font-semibold sm:min-w-[100px] sm:text-sm sm:font-medium">
            {displayMonth()}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 sm:h-9 sm:w-9"
            onClick={() => changeMonth(1)}
            disabled={currentMonth >= getMonthKey(new Date())}
            aria-label="次月"
          >
            <ChevronRight className="h-5 w-5 sm:h-4 sm:w-4" />
          </Button>
        </div>
      </div>

      <DashboardGrid>{widgets}</DashboardGrid>
    </div>
  );
}
