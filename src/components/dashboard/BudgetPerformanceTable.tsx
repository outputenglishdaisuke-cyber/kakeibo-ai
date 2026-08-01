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

function CategoryLabel({
  name,
  color,
  bold = false,
}: {
  name: string;
  color?: string;
  bold?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 sm:gap-2",
        bold ? "font-bold" : "font-medium"
      )}
    >
      {color ? (
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full sm:h-2.5 sm:w-2.5"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      ) : null}
      <span className="truncate">{name}</span>
    </span>
  );
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
    <Card className={cn("h-full min-w-0", className)}>
      <CardHeader className="pb-3">
        <CardTitle>予算との比較</CardTitle>
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
          <>
            {/* スマホ: 横スクロールなしのコンパクト表示 */}
            <div className="overflow-hidden rounded-lg border border-gray-200 sm:hidden">
              <ul className="divide-y divide-gray-100 text-[12px] leading-snug">
                {data.rows.map((row) => (
                  <li
                    key={row.categoryId}
                    className="flex items-start justify-between gap-3 px-3 py-2.5"
                  >
                    <div className="min-w-0 pt-0.5">
                      <CategoryLabel
                        name={row.categoryName}
                        color={row.color}
                      />
                    </div>
                    <div className="flex-shrink-0 text-right tabular-nums">
                      <div className="text-gray-700">
                        <span className="text-gray-400">目標 </span>
                        {formatCurrency(row.targetAmount)}
                      </div>
                      <div className="text-gray-700">
                        <span className="text-gray-400">実績 </span>
                        {formatCurrency(row.actualAmount)}
                      </div>
                      <div className={cn("mt-0.5", differenceClass(row.difference))}>
                        {formatDifference(row.difference)}
                      </div>
                    </div>
                  </li>
                ))}
                <li className="flex items-start justify-between gap-3 bg-gray-50 px-3 py-2.5">
                  <div className="pt-0.5 font-bold">合計</div>
                  <div className="flex-shrink-0 text-right tabular-nums">
                    <div className="font-bold text-gray-900">
                      <span className="font-normal text-gray-400">目標 </span>
                      {formatCurrency(data.totals.targetAmount)}
                    </div>
                    <div className="font-bold text-gray-900">
                      <span className="font-normal text-gray-400">実績 </span>
                      {formatCurrency(data.totals.actualAmount)}
                    </div>
                    <div
                      className={cn(
                        "mt-0.5",
                        differenceClass(data.totals.difference)
                      )}
                    >
                      {formatDifference(data.totals.difference)}
                    </div>
                  </div>
                </li>
              </ul>
            </div>

            {/* PC: 従来の表レイアウト */}
            <div className="hidden overflow-x-auto rounded-lg border border-gray-200 sm:block">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-gray-600">
                    <th className="px-4 py-2.5 text-left font-medium">カテゴリ</th>
                    <th className="px-4 py-2.5 text-right font-medium">目標</th>
                    <th className="px-4 py-2.5 text-right font-medium">実績</th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      目標との差
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.rows.map((row) => (
                    <tr key={row.categoryId} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5">
                        <CategoryLabel
                          name={row.categoryName}
                          color={row.color}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatCurrency(row.targetAmount)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatCurrency(row.actualAmount)}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2.5 text-right tabular-nums",
                          differenceClass(row.difference)
                        )}
                      >
                        {formatDifference(row.difference)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 bg-gray-50">
                    <td className="px-4 py-2.5 font-bold">合計</td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums">
                      {formatCurrency(data.totals.targetAmount)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold tabular-nums">
                      {formatCurrency(data.totals.actualAmount)}
                    </td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right tabular-nums",
                        differenceClass(data.totals.difference)
                      )}
                    >
                      {formatDifference(data.totals.difference)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
