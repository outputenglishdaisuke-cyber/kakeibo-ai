"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ExpensePieChart } from "@/components/charts/ExpensePieChart";
import { MonthlyTrendChart } from "@/components/charts/MonthlyTrendChart";
import { formatCurrency, getMonthKey } from "@/lib/utils";
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

      {loading ? (
        <div className="flex h-64 items-center justify-center text-gray-400">
          読み込み中...
        </div>
      ) : (
        <>
          {/* 合計カード */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
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
            <Card>
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
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-gray-500">
                  最大支出カテゴリ
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xl font-bold text-gray-900 truncate">
                  {summary?.categories.sort((a, b) => b.total - a.total)[0]
                    ?.categoryName ?? "-"}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* PC: 横並び / スマホ: 縦積み */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>カテゴリ別支出</CardTitle>
              </CardHeader>
              <CardContent>
                <ExpensePieChart data={summary?.categories ?? []} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>月次推移（直近6ヶ月）</CardTitle>
              </CardHeader>
              <CardContent>
                <MonthlyTrendChart data={trend?.trend ?? []} />
              </CardContent>
            </Card>
          </div>

          {/* カテゴリ別一覧 */}
          {summary && summary.categories.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>カテゴリ別内訳</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {summary.categories
                    .sort((a, b) => b.total - a.total)
                    .map((cat) => (
                      <div
                        key={cat.categoryId ?? "uncategorized"}
                        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <div
                            className="h-3 w-3 flex-shrink-0 rounded-full"
                            style={{ backgroundColor: cat.color }}
                          />
                          <span className="truncate text-sm text-gray-700">
                            {cat.categoryName}
                          </span>
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
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
