"use client";

import { useEffect, useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/utils";
import type { CategorySummary } from "@/types";

interface Props {
  data: CategorySummary[];
}

const tooltipFormatter = (value: unknown) => {
  if (typeof value === "number") return [formatCurrency(value), "金額"] as const;
  return [String(value), "金額"] as const;
};

function useIsNarrow(breakpointPx = 640) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpointPx]);
  return narrow;
}

export function ExpensePieChart({ data }: Props) {
  const narrow = useIsNarrow();

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-400">
        データがありません
      </div>
    );
  }

  // Recharts は nameKey で凡例・ラベル名を取る。未分類も明示する。
  const chartData = data.map((d) => ({
    ...d,
    categoryName: d.categoryName?.trim() ? d.categoryName : "未分類",
  }));

  return (
    <div className="h-[260px] w-full sm:h-[320px]">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={narrow ? 45 : 60}
            outerRadius={narrow ? 80 : 110}
            paddingAngle={2}
            dataKey="total"
            nameKey="categoryName"
            label={
              narrow
                ? false
                : ({ payload }: { payload?: CategorySummary }) =>
                    payload
                      ? `${payload.categoryName || "未分類"} ${payload.percentage}%`
                      : ""
            }
            labelLine={false}
          >
            {chartData.map((entry) => (
              <Cell
                key={entry.categoryId ?? `uncategorized-${entry.categoryName}`}
                fill={entry.color}
              />
            ))}
          </Pie>
          <Tooltip formatter={tooltipFormatter} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
