"use client";

/**
 * 明細一覧の URL クエリ ↔ フィルター条件の変換。
 * App Router では useSearchParams 経由で使うこと（SSR で window を読まない）。
 */

import { getMonthKey } from "@/lib/utils";

export type SourceFilter = "CSV" | "IMAGE" | "MANUAL";

export const UNCATEGORIZED_KEY = "uncategorized";

export function parseCategoriesFromParam(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSourcesFromParam(raw: string | null): SourceFilter[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SourceFilter =>
      s === "CSV" || s === "IMAGE" || s === "MANUAL"
    );
}

export function parseFiltersFromSearchParams(searchParams: {
  get: (key: string) => string | null;
}): {
  month: string;
  categoryKeys: string[];
  sources: SourceFilter[];
} {
  let categoryKeys = parseCategoriesFromParam(searchParams.get("categories"));
  const single = searchParams.get("category");
  if (single && categoryKeys.length === 0) {
    const trimmed = single.trim();
    if (
      trimmed === "未分類" ||
      trimmed === "null" ||
      trimmed === "uncategorized"
    ) {
      categoryKeys = [UNCATEGORIZED_KEY];
    } else {
      categoryKeys = [trimmed];
    }
  }
  const monthParam = searchParams.get("month");
  return {
    month:
      monthParam && /^\d{4}-\d{2}$/.test(monthParam)
        ? monthParam
        : getMonthKey(new Date()),
    categoryKeys,
    sources: parseSourcesFromParam(searchParams.get("sources")),
  };
}

export function buildFilterSearchParams(
  month: string,
  categoryKeys: string[],
  sources: SourceFilter[]
): string {
  const params = new URLSearchParams();
  params.set("month", month);
  if (categoryKeys.length > 0) {
    params.set("categories", categoryKeys.join(","));
  }
  if (sources.length > 0) {
    params.set("sources", sources.join(","));
  }
  return params.toString();
}

export function sameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
