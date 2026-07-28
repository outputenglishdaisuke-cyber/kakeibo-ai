"use client";

import type { Category } from "@/types";
import { cn } from "@/lib/utils";

interface CategorySelectProps {
  categories: Category[];
  value: string | null | undefined;
  onChange: (categoryId: string) => void;
  disabled?: boolean;
  className?: string;
  /** コンパクト表示（テーブル行向け） */
  compact?: boolean;
  "aria-label"?: string;
}

/**
 * カテゴリ選択セレクト。未分類 + 登録済みカテゴリを動的に列挙する。
 */
export function CategorySelect({
  categories,
  value,
  onChange,
  disabled,
  className,
  compact = false,
  "aria-label": ariaLabel = "カテゴリ",
}: CategorySelectProps) {
  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        "rounded border border-gray-300 bg-white text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:cursor-wait disabled:opacity-60",
        compact
          ? "min-w-[140px] px-2 py-1.5 text-sm"
          : "h-11 w-full px-3 text-base md:h-auto md:py-2 md:text-sm",
        className
      )}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">未分類</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
