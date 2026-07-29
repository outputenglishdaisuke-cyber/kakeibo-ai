import type { LayoutItem } from "react-grid-layout";

export const DASHBOARD_LAYOUT_KEY = "dashboard.layout";

export type DashboardWidgetId =
  | "stat-total"
  | "stat-count"
  | "stat-top"
  | "pie"
  | "trend"
  | "breakdown"
  | "budget"
  | "matrix";

export type DashboardLayoutItem = LayoutItem;

/** 12カラムグリッドの初期レイアウト */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutItem[] = [
  { i: "stat-total", x: 0, y: 0, w: 4, h: 3, minW: 3, minH: 2 },
  { i: "stat-count", x: 4, y: 0, w: 4, h: 3, minW: 3, minH: 2 },
  { i: "stat-top", x: 8, y: 0, w: 4, h: 3, minW: 3, minH: 2 },
  { i: "pie", x: 0, y: 3, w: 6, h: 8, minW: 4, minH: 6 },
  { i: "trend", x: 6, y: 3, w: 6, h: 8, minW: 4, minH: 6 },
  { i: "breakdown", x: 0, y: 11, w: 12, h: 7, minW: 6, minH: 4 },
  { i: "budget", x: 0, y: 18, w: 12, h: 8, minW: 6, minH: 6 },
  { i: "matrix", x: 0, y: 26, w: 12, h: 12, minW: 6, minH: 8 },
];

export const DASHBOARD_WIDGET_IDS: DashboardWidgetId[] = [
  "stat-total",
  "stat-count",
  "stat-top",
  "pie",
  "trend",
  "breakdown",
  "budget",
  "matrix",
];

/** 保存レイアウトに欠落ウィジェットがあればデフォルト位置で補完 */
export function mergeWithDefaultLayout(
  saved: DashboardLayoutItem[] | null | undefined
): DashboardLayoutItem[] {
  const byId = new Map((saved ?? []).map((item) => [item.i, item]));
  const result: DashboardLayoutItem[] = [];

  for (const def of DEFAULT_DASHBOARD_LAYOUT) {
    const existing = byId.get(def.i);
    if (existing) {
      result.push({
        ...def,
        ...existing,
        i: def.i,
        minW: def.minW,
        minH: def.minH,
      });
    } else {
      // 既存ユーザーの保存レイアウトに新ウィジェットを追加する場合は、
      // 既存ブロックと重ならないよう一番下へ配置する。
      const savedBottom = (saved ?? []).reduce(
        (bottom, item) => Math.max(bottom, item.y + item.h),
        0
      );
      result.push({
        ...def,
        y: saved && saved.length > 0 ? savedBottom : def.y,
      });
    }
  }
  return result;
}
