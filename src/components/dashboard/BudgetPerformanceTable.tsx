"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCurrency } from "@/lib/utils";

interface BudgetRow {
  categoryId: string;
  categoryName: string;
  color: string;
  targetAmount: number;
  actualAmount: number;
  difference: number;
}

interface BudgetResponse {
  month: string;
  rows: BudgetRow[];
  totals: {
    targetAmount: number;
    actualAmount: number;
    difference: number;
  };
}

function formatDifference(amount: number) {
  if (amount === 0) return "±0円";
  return `${amount > 0 ? "+" : "−"}${formatCurrency(Math.abs(amount))}`;
}

function differenceClass(amount: number) {
  if (amount > 0) return "font-semibold text-red-600";
  if (amount < 0) return "font-semibold text-blue-600";
  return "font-semibold text-gray-500";
}

export function BudgetPerformanceTable({
  month,
  className,
}: {
  month: string;
  className?: string;
}) {
  const [data, setData] = useState<BudgetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetch(`/api/budgets?month=${encodeURIComponent(month)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "取得に失敗しました");
        setData(body);
      })
      .catch((err) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(
          err instanceof Error ? err.message : "予算実績の取得に失敗しました"
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [month]);

  return (
    <Card className={cn("h-full", className)}>
      <CardHeader>
        <CardTitle>予算に対する実績</CardTitle>
        <p className="text-xs text-gray-500">
          青は予算内、赤は予算超過です。家賃は比較対象に含みません。
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex h-36 items-center justify-center text-gray-400">
            読み込み中...
          </div>
        ) : error ? (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : !data ? null : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-gray-600">
                  <th className="px-4 py-3 text-left font-medium">カテゴリ</th>
                  <th className="px-4 py-3 text-right font-medium">目標</th>
                  <th className="px-4 py-3 text-right font-medium">実績</th>
                  <th className="px-4 py-3 text-right font-medium">
                    目標との差
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.rows.map((row) => (
                  <tr key={row.categoryId} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2 font-medium">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: row.color }}
                          aria-hidden
                        />
                        {row.categoryName}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(row.targetAmount)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(row.actualAmount)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right tabular-nums",
                        differenceClass(row.difference)
                      )}
                    >
                      {formatDifference(row.difference)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-gray-300 bg-gray-50">
                  <td className="px-4 py-3 font-bold">合計</td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums">
                    {formatCurrency(data.totals.targetAmount)}
                  </td>
                  <td className="px-4 py-3 text-right font-bold tabular-nums">
                    {formatCurrency(data.totals.actualAmount)}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-3 text-right tabular-nums",
                      differenceClass(data.totals.difference)
                    )}
                  >
                    {formatDifference(data.totals.difference)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

