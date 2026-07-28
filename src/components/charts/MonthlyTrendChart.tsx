"use client";

import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  Bar,
  ComposedChart,
} from "recharts";
import { formatCurrency } from "@/lib/utils";

interface MonthData {
  month: string;
  total: number;
}

interface Props {
  data: MonthData[];
}

const tooltipFormatter = (value: unknown) => {
  if (typeof value === "number") return [formatCurrency(value), "支出"] as const;
  return [String(value), "支出"] as const;
};

export function MonthlyTrendChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-gray-400">
        データがありません
      </div>
    );
  }

  const formatted = data.map((d) => ({
    ...d,
    label: `${parseInt(d.month.split("-")[1])}月`,
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={formatted}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="label" tick={{ fontSize: 12 }} />
        <YAxis
          tickFormatter={(v: number) => `¥${(v / 1000).toFixed(0)}k`}
          tick={{ fontSize: 12 }}
        />
        <Tooltip formatter={tooltipFormatter} />
        <Bar dataKey="total" fill="#6366f1" radius={[4, 4, 0, 0] as [number, number, number, number]} />
        <Line
          type="monotone"
          dataKey="total"
          stroke="#f59e0b"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
