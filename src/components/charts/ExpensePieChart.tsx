"use client";

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

// recharts の Tooltip formatter の型を満たす
const tooltipFormatter = (value: unknown) => {
  if (typeof value === "number") return [formatCurrency(value), "金額"] as const;
  return [String(value), "金額"] as const;
};

export function ExpensePieChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-400">
        データがありません
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={110}
          paddingAngle={2}
          dataKey="total"
          nameKey="categoryName"
          label={({ name, payload }: { name?: string; payload?: CategorySummary }) =>
            payload ? `${payload.categoryName} ${payload.percentage}%` : name ?? ""
          }
          labelLine={false}
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip formatter={tooltipFormatter} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}
