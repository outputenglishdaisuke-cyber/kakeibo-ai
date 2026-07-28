import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
  }).format(amount);
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function getMonthKey(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function getMonthRange(monthKey: string): { start: Date; end: Date } {
  const [year, month] = monthKey.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

/** YYYY-MM を delta ヶ月ずらす */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  return getMonthKey(new Date(y, m - 1 + delta, 1));
}

/** from〜to（両端含む）の YYYY-MM 配列を返す。from > to の場合は空 */
export function listMonthKeys(from: string, to: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return [];
  if (from > to) return [];
  const keys: string[] = [];
  let cur = from;
  // 安全上限（約50年）
  for (let i = 0; i < 600 && cur <= to; i++) {
    keys.push(cur);
    cur = shiftMonthKey(cur, 1);
  }
  return keys;
}

/** 終了月を含む直近 n ヶ月の from/to */
export function recentMonthRange(
  n: number,
  endMonth: string = getMonthKey(new Date())
): { from: string; to: string } {
  const safeN = Math.max(1, Math.min(n, 120));
  return {
    from: shiftMonthKey(endMonth, -(safeN - 1)),
    to: endMonth,
  };
}
