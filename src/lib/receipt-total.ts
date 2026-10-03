import type { ExtractedImageTransaction } from "@/types";

/** 品目の合計との差がこの割合（＋端数1円）以内で、合計の方が大きければ消費税とみなす */
const MAX_TAX_RATE = 0.1;

export const TAX_LINE_LABEL = "消費税";
export const ADJUST_LINE_LABEL = "調整（レシート合計との差）";

/** 読み取った日付がこの年数より前なら、年の読み違い（例: 令和8年を令和6年）を疑う */
const MAX_PAST_YEARS = 2;

/**
 * 読み取った日付が未来、または2年以上前なら確認を促す文言を返す（純関数）。
 * today は YYYY-MM-DD（日本時間の今日）。
 */
export function receiptDateWarning(date: string, today: string): string | null {
  const d = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (d > today) {
    return `レシートの日付（${d}）が未来になっています。年や月の読み取りを確認してください`;
  }
  const [y, m, day] = today.split("-").map(Number);
  const limit = `${y - MAX_PAST_YEARS}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (d < limit) {
    return `レシートの日付（${d}）が${MAX_PAST_YEARS}年以上前です。年の読み取り（和暦の読み違いなど）を確認してください`;
  }
  return null;
}

/**
 * レシートの品目を、税込の支払合計（receiptTotal）に揃える（純関数）。
 * 税抜表示の店では品目の合計が税抜になり、カード明細の金額と一致しないため、
 * 差額を「消費税」の行としてカテゴリごとの小計の比で加える。
 * 差が税として説明できない（合計の方が小さい・10%を超える）場合は「調整」の行にして warning を返す。
 * 合計が読めない場合は推測で直さず、品目のまま warning を返す。
 */
export function alignReceiptToTotal(
  items: ExtractedImageTransaction[],
  receiptTotal: number | null | undefined
): { items: ExtractedImageTransaction[]; adjustment: number; warning: string | null } {
  const isItemized = items.some((i) => i.itemName);
  if (items.length === 0) return { items, adjustment: 0, warning: null };

  const total = receiptTotal != null && Number.isFinite(receiptTotal) ? Math.round(receiptTotal) : null;
  if (total === null || total <= 0) {
    return {
      items,
      adjustment: 0,
      warning: isItemized ? "レシートの合計金額を読み取れなかったため、税込の金額か確認できません" : null,
    };
  }

  if (!isItemized) {
    if (items.length !== 1 || items[0].amount === total) return { items, adjustment: 0, warning: null };
    return { items: [{ ...items[0], amount: total }], adjustment: total - items[0].amount, warning: null };
  }

  const sum = items.reduce((s, i) => s + i.amount, 0);
  const diff = total - sum;
  if (diff === 0) return { items, adjustment: 0, warning: null };

  const isTax = diff > 0 && diff <= Math.ceil(sum * MAX_TAX_RATE) + 1;
  const label = isTax ? TAX_LINE_LABEL : ADJUST_LINE_LABEL;

  const subtotals = new Map<string | null, number>();
  for (const i of items) {
    if (i.amount <= 0) continue;
    const key = i.categoryName ?? null;
    subtotals.set(key, (subtotals.get(key) ?? 0) + i.amount);
  }
  if (subtotals.size === 0) subtotals.set(items[0].categoryName ?? null, 1);

  const weight = [...subtotals.values()].reduce((s, n) => s + n, 0);
  const shares = [...subtotals].map(([categoryName, sub]) => ({
    categoryName,
    sub,
    amount: Math.trunc((diff * sub) / weight),
  }));
  const largest = shares.reduce((a, b) => (b.sub > a.sub ? b : a));
  largest.amount += diff - shares.reduce((s, x) => s + x.amount, 0);

  const first = items[0];
  const store = first.storeName ?? first.description.split(" / ")[0];
  const lines = shares
    .filter((s) => s.amount !== 0)
    .map((s): ExtractedImageTransaction => {
      const itemName = shares.length > 1 ? `${label}（${s.categoryName ?? "未分類"}）` : label;
      return {
        date: first.date,
        description: `${store} / ${itemName}`,
        amount: s.amount,
        storeName: first.storeName ?? null,
        itemName,
        categoryName: s.categoryName,
        paymentMethod: first.paymentMethod ?? null,
        receiptTotal: total,
      };
    });

  return {
    items: [...items, ...lines],
    adjustment: diff,
    warning: isTax
      ? null
      : `品目の合計（${sum}円）とレシートの合計（${total}円）の差 ${diff}円を「調整」の行として加えました。読み取り結果を確認してください`,
  };
}
