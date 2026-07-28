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
  onCategoryClick?: (category: CategorySummary) => void;
}

const tooltipFormatter = (value: unknown, name: unknown) => {
  const label =
    typeof name === "string" && name.trim() ? name : "未分類";
  if (typeof value === "number") return [formatCurrency(value), label] as const;
  return [String(value), label] as const;
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

export function ExpensePieChart({ data, onCategoryClick }: Props) {
  const narrow = useIsNarrow();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-400">
        データがありません
      </div>
    );
  }

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
            cursor={onCategoryClick ? "pointer" : "default"}
            onClick={(_, index) => {
              if (!onCategoryClick) return;
              const item = chartData[index];
              if (item) onCategoryClick(item);
            }}
            onMouseEnter={(_, index) => setActiveIndex(index)}
            onMouseLeave={() => setActiveIndex(null)}
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
            {chartData.map((entry, index) => (
              <Cell
                key={entry.categoryId ?? `uncategorized-${entry.categoryName}`}
                fill={entry.color}
                stroke={activeIndex === index ? "#fff" : "transparent"}
                strokeWidth={activeIndex === index ? 2 : 0}
                style={{
                  cursor: onCategoryClick ? "pointer" : undefined,
                  filter:
                    activeIndex === index
                      ? "brightness(1.12)"
                      : activeIndex !== null
                        ? "brightness(0.92)"
                        : undefined,
                  outline: "none",
                  transition: "filter 120ms ease",
                }}
              />
            ))}
          </Pie>
          <Tooltip formatter={tooltipFormatter} />
          <Legend
            onClick={(payload) => {
              if (!onCategoryClick) return;
              const name =
                typeof payload?.value === "string" ? payload.value : null;
              if (!name) return;
              const item = chartData.find((d) => d.categoryName === name);
              if (item) onCategoryClick(item);
            }}
            wrapperStyle={onCategoryClick ? { cursor: "pointer" } : undefined}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
