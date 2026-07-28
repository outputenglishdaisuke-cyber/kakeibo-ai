"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  formatCurrency,
  getMonthKey,
  recentMonthRange,
  shiftMonthKey,
  cn,
} from "@/lib/utils";
import { buildTransactionsFilterUrl } from "@/lib/transactions-url";
import type { CategoryMonthMatrix } from "@/types";

const PRESETS = [
  { label: "直近6ヶ月", months: 6 },
  { label: "直近12ヶ月", months: 12 },
  { label: "直近24ヶ月", months: 24 },
  { label: "直近36ヶ月", months: 36 },
] as const;

function formatMonthHeader(monthKey: string) {
  const [y, m] = monthKey.split("-");
  return `${y}/${parseInt(m, 10)}`;
}

function displayMonthLabel(monthKey: string) {
  const [y, m] = monthKey.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

function formatCell(amount: number) {
  if (!amount) return "—";
  return formatCurrency(amount);
}

function heatBackground(amount: number, max: number): string | undefined {
  if (!amount || max <= 0) return undefined;
  const t = Math.min(1, amount / max);
  // indigo 系の薄いヒートマップ
  const alpha = 0.08 + t * 0.42;
  return `rgba(99, 102, 241, ${alpha.toFixed(3)})`;
}

export function CategoryMonthlyMatrixTable({
  className,
}: {
  className?: string;
} = {}) {
  const router = useRouter();
  const today = getMonthKey(new Date());
  const initial = recentMonthRange(6, today);

  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [activePreset, setActivePreset] = useState<number | null>(6);
  const [data, setData] = useState<CategoryMonthMatrix | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const applyPreset = (months: number) => {
    const range = recentMonthRange(months, today);
    setFrom(range.from);
    setTo(range.to);
    setActivePreset(months);
  };

  const onCustomFrom = (value: string) => {
    if (!value) return;
    setFrom(value);
    setActivePreset(null);
    if (value > to) setTo(value);
  };

  const onCustomTo = (value: string) => {
    if (!value) return;
    setTo(value);
    setActivePreset(null);
    if (value < from) setFrom(value);
  };

  const fetchMatrix = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      const json = await res.json();
      if (!res.ok) {
        setError(typeof json.error === "string" ? json.error : "取得に失敗しました");
        setData(null);
        return;
      }
      setData(json as CategoryMonthMatrix);
    } catch {
      setError("取得に失敗しました");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    fetchMatrix();
  }, [fetchMatrix]);

  const maxAmount = useMemo(() => {
    if (!data) return 0;
    let max = 0;
    for (const row of data.categories) {
      for (const a of row.amounts) if (a > max) max = a;
    }
    return max;
  }, [data]);

  const rangeLabel = `${displayMonthLabel(from)} 〜 ${displayMonthLabel(to)}`;

  // type="month" の min/max（データが極端に未来にならないよう）
  const minMonth = shiftMonthKey(today, -119);
  const maxMonth = today;

  const openCell = (
    month: string,
    categoryId: string | null,
    categoryName: string,
    amount: number
  ) => {
    if (!amount) {
      setHint("この月・カテゴリにはデータがありません");
      setTimeout(() => setHint(null), 1800);
      return;
    }
    router.push(
      buildTransactionsFilterUrl({
        month,
        categoryId,
        categoryName,
      })
    );
  };

  return (
    <Card className={cn(className)}>
      <CardHeader className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>カテゴリ別月次推移表</CardTitle>
            <p className="mt-1 text-sm text-gray-500">
              指定期間のカテゴリ×月の支出合計（{rangeLabel}）。金額セルをクリックすると明細一覧へ移動します。
            </p>
            {hint && (
              <p className="mt-1 text-xs text-amber-600" role="status">
                {hint}
              </p>
            )}
          </div>
          {data && !loading && (
            <p className="text-sm font-medium text-indigo-600">
              期間合計 {formatCurrency(data.grandTotal)}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.months}
                type="button"
                size="sm"
                variant={activePreset === p.months ? "default" : "outline"}
                onClick={() => applyPreset(p.months)}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">開始月</span>
              <input
                type="month"
                className="h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-indigo-500 focus:outline-none"
                value={from}
                min={minMonth}
                max={maxMonth}
                onChange={(e) => onCustomFrom(e.target.value)}
              />
            </label>
            <span className="hidden pb-2 text-gray-400 sm:inline">〜</span>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-gray-700">終了月</span>
              <input
                type="month"
                className="h-10 rounded-lg border border-gray-300 px-3 text-sm focus:border-indigo-500 focus:outline-none"
                value={to}
                min={minMonth}
                max={maxMonth}
                onChange={(e) => onCustomTo(e.target.value)}
              />
            </label>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex h-40 items-center justify-center text-gray-400">
            読み込み中...
          </div>
        ) : error ? (
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : !data || data.months.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-gray-400">
            表示できるデータがありません
          </div>
        ) : (
          <div className="relative max-h-[min(70vh,640px)] overflow-auto rounded-lg border border-gray-200">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th
                    className={cn(
                      "sticky left-0 top-0 z-30 border-b border-r border-gray-200 bg-gray-50 px-3 py-2 text-left font-semibold text-gray-700",
                      "min-w-[132px] shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]"
                    )}
                  >
                    カテゴリ
                  </th>
                  {data.months.map((m) => (
                    <th
                      key={m}
                      className="sticky top-0 z-20 border-b border-gray-200 bg-gray-50 px-2 py-2 text-right font-medium text-gray-600 whitespace-nowrap"
                    >
                      {formatMonthHeader(m)}
                    </th>
                  ))}
                  <th
                    className={cn(
                      "sticky right-0 top-0 z-30 border-b border-l border-gray-200 bg-indigo-50 px-3 py-2 text-right font-semibold text-indigo-800",
                      "min-w-[104px] shadow-[-2px_0_4px_-2px_rgba(0,0,0,0.08)]"
                    )}
                  >
                    合計
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.categories.map((row) => (
                  <tr key={row.categoryId ?? "uncategorized"} className="group">
                    <td
                      className={cn(
                        "sticky left-0 z-10 border-b border-r border-gray-100 bg-white px-3 py-2 font-medium text-gray-800",
                        "shadow-[2px_0_4px_-2px_rgba(0,0,0,0.06)] group-hover:bg-gray-50"
                      )}
                    >
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: row.color }}
                          aria-hidden
                        />
                        <span className="truncate">{row.categoryName}</span>
                      </span>
                    </td>
                    {row.amounts.map((amount, i) => {
                      const month = data.months[i];
                      const clickable = amount > 0;
                      return (
                        <td
                          key={`${row.categoryId ?? "u"}-${month}`}
                          role={clickable ? "button" : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          onClick={() =>
                            openCell(
                              month,
                              row.categoryId,
                              row.categoryName,
                              amount
                            )
                          }
                          onKeyDown={(e) => {
                            if (!clickable) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openCell(
                                month,
                                row.categoryId,
                                row.categoryName,
                                amount
                              );
                            }
                          }}
                          className={cn(
                            "border-b border-gray-100 px-2 py-2 text-right tabular-nums text-gray-800",
                            clickable
                              ? "cursor-pointer hover:ring-2 hover:ring-indigo-300 hover:ring-inset hover:brightness-95"
                              : "cursor-default opacity-70"
                          )}
                          style={{
                            backgroundColor: heatBackground(amount, maxAmount),
                          }}
                          title={
                            clickable
                              ? `${row.categoryName} / ${displayMonthLabel(month)} の明細を表示`
                              : "データなし"
                          }
                        >
                          {formatCell(amount)}
                        </td>
                      );
                    })}
                    <td
                      className={cn(
                        "sticky right-0 z-10 border-b border-l border-gray-100 bg-indigo-50/80 px-3 py-2 text-right font-semibold tabular-nums text-indigo-900",
                        "shadow-[-2px_0_4px_-2px_rgba(0,0,0,0.06)]"
                      )}
                    >
                      {formatCell(row.rowTotal)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td
                    className={cn(
                      "sticky bottom-0 left-0 z-20 border-t-2 border-r border-gray-200 bg-gray-100 px-3 py-2.5 font-semibold text-gray-900",
                      "shadow-[2px_0_4px_-2px_rgba(0,0,0,0.08)]"
                    )}
                  >
                    月合計
                  </td>
                  {data.monthTotals.map((total, i) => (
                    <td
                      key={`mt-${data.months[i]}`}
                      className="sticky bottom-0 z-10 border-t-2 border-gray-200 bg-gray-100 px-2 py-2.5 text-right font-semibold tabular-nums text-gray-900"
                    >
                      {formatCell(total)}
                    </td>
                  ))}
                  <td
                    className={cn(
                      "sticky bottom-0 right-0 z-30 border-t-2 border-l border-gray-200 bg-indigo-100 px-3 py-2.5 text-right font-bold tabular-nums text-indigo-950",
                      "shadow-[-2px_0_4px_-2px_rgba(0,0,0,0.08)]"
                    )}
                  >
                    {formatCurrency(data.grandTotal)}
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
