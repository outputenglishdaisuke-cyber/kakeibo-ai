import type { ParsedTransaction, Source } from "@/types";

/** memo に保存するレシート品目内訳 */
export interface ReceiptItemsMemo {
  type: "receipt_items";
  receiptGroupId: string;
  storeName: string;
  items: Array<{
    itemName: string;
    amount: number;
    categoryId?: string | null;
    categoryName?: string | null;
    /** 移行時に退避した元 Transaction.id */
    originalId?: string;
  }>;
}

export type ConfirmableTransaction = {
  date: string;
  description: string;
  amount: number;
  source: Source;
  categoryId?: string | null;
  categoryName?: string | null;
  categoryColor?: string | null;
  receiptGroupId?: string | null;
  storeName?: string | null;
  itemName?: string | null;
  memo?: string | null;
};

export type ReceiptGroupPlan =
  | {
      mode: "aggregate";
      receiptGroupId: string;
      storeName: string;
      categoryId: string;
      categoryName: string | null;
      itemCount: number;
      totalAmount: number;
      /** 判定に使った主要カテゴリ以外の品目数（memo には残る） */
      minorityItemCount?: number;
    }
  | {
      mode: "split";
      receiptGroupId: string;
      storeName: string;
      itemCount: number;
      totalAmount: number;
      reason: "mixed_categories" | "uncategorized" | "single_item";
    };

/** 集約判定から除外する付帯行（レジ袋・税区分・値引など） */
const NOISE_ITEM_RE =
  /レジ袋|手提げ袋|値引|割引|値引き|税率対象|code\s*128|ポイント|残高|お預り|お釣り|小計|合計|^商品$/i;

function resolveStoreName(group: ConfirmableTransaction[]): string {
  const fromField = group.find((g) => g.storeName?.trim())?.storeName?.trim();
  if (fromField) return fromField;
  const fromDesc = group[0]?.description?.split(" / ")[0]?.trim();
  return fromDesc || "レシート";
}

function isReceiptLineItem(tx: ConfirmableTransaction): boolean {
  return Boolean(tx.receiptGroupId && (tx.itemName || tx.storeName));
}

function itemLabel(tx: ConfirmableTransaction): string {
  return `${tx.itemName ?? ""} ${tx.description ?? ""}`.trim();
}

export function isAggregationNoiseItem(tx: ConfirmableTransaction): boolean {
  const label = itemLabel(tx);
  if (NOISE_ITEM_RE.test(label)) return true;
  // レジ袋相当の極小額（カテゴリだけ違う付帯費）
  if (Math.abs(tx.amount) > 0 && Math.abs(tx.amount) <= 10) return true;
  return false;
}

/**
 * 同一レシート内のカテゴリを見て、まとめ登録か品目分割かを決める。
 *
 * 1. 付帯行（レジ袋・値引・税区分など）は判定から除外
 * 2. 判定対象がすべて同一カテゴリ → aggregate
 * 3. 主要カテゴリ以外が少数（品目数≤3 かつ 金額比≤35%）→ 主要カテゴリで aggregate
 *    （内訳は memo に各品目のカテゴリ付きで残す）
 * 4. 未分類がある / それ以外の複数カテゴリ → split
 */
export function planReceiptGroup(
  group: ConfirmableTransaction[]
): ReceiptGroupPlan {
  const receiptGroupId = group[0]?.receiptGroupId ?? "unknown";
  const storeName = resolveStoreName(group);
  const totalAmount = group.reduce((s, g) => s + g.amount, 0);
  const itemCount = group.length;

  if (itemCount <= 1) {
    return {
      mode: "split",
      receiptGroupId,
      storeName,
      itemCount,
      totalAmount,
      reason: "single_item",
    };
  }

  const meaningful = group.filter((g) => !isAggregationNoiseItem(g));
  const judged = meaningful.length > 0 ? meaningful : group;

  if (judged.some((g) => !g.categoryId)) {
    return {
      mode: "split",
      receiptGroupId,
      storeName,
      itemCount,
      totalAmount,
      reason: "uncategorized",
    };
  }

  const byCategory = new Map<
    string,
    { count: number; amount: number; categoryName: string | null }
  >();
  for (const g of judged) {
    const id = g.categoryId as string;
    const cur = byCategory.get(id) ?? {
      count: 0,
      amount: 0,
      categoryName: g.categoryName ?? null,
    };
    cur.count += 1;
    cur.amount += Math.abs(g.amount);
    cur.categoryName = g.categoryName ?? cur.categoryName;
    byCategory.set(id, cur);
  }

  const ranked = [...byCategory.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return b[1].amount - a[1].amount;
  });
  const [majorityId, majority] = ranked[0];
  const judgedAmount = judged.reduce((s, g) => s + Math.abs(g.amount), 0) || 1;
  const minorityCount = judged.length - majority.count;
  const minorityAmountShare = 1 - majority.amount / judgedAmount;

  // 品目数で明確な過半数があり、少数派が小さい場合のみまとめる
  const hasClearMajority = majority.count * 2 > judged.length;
  const canAggregate =
    ranked.length === 1 ||
    (hasClearMajority &&
      minorityCount <= 3 &&
      minorityAmountShare <= 0.35);

  if (canAggregate) {
    return {
      mode: "aggregate",
      receiptGroupId,
      storeName,
      categoryId: majorityId,
      categoryName: majority.categoryName,
      itemCount,
      totalAmount,
      minorityItemCount: minorityCount,
    };
  }

  return {
    mode: "split",
    receiptGroupId,
    storeName,
    itemCount,
    totalAmount,
    reason: "mixed_categories",
  };
}

export function buildReceiptItemsMemo(
  group: ConfirmableTransaction[],
  storeName: string,
  receiptGroupId: string
): string {
  const payload: ReceiptItemsMemo = {
    type: "receipt_items",
    receiptGroupId,
    storeName,
    items: group.map((g) => ({
      itemName: g.itemName?.trim() || g.description,
      amount: g.amount,
      categoryId: g.categoryId ?? null,
      categoryName: g.categoryName ?? null,
    })),
  };
  return JSON.stringify(payload);
}

export function parseReceiptItemsMemo(
  memo: string | null | undefined
): ReceiptItemsMemo | null {
  if (!memo?.trim()) return null;
  try {
    const parsed = JSON.parse(memo) as ReceiptItemsMemo;
    if (
      parsed?.type !== "receipt_items" ||
      !Array.isArray(parsed.items) ||
      parsed.items.length === 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * レシート品目を「同一カテゴリなら1件」「複数/未分類なら品目ごと」に変換する。
 * CSV・手入力・単独行はそのまま通す。
 */
export function aggregateSameCategoryReceipts(
  transactions: ConfirmableTransaction[]
): ConfirmableTransaction[] {
  const result: ConfirmableTransaction[] = [];
  let i = 0;

  while (i < transactions.length) {
    const tx = transactions[i];
    const groupId = tx.receiptGroupId;

    if (!groupId || !isReceiptLineItem(tx)) {
      result.push(tx);
      i += 1;
      continue;
    }

    let j = i + 1;
    while (
      j < transactions.length &&
      transactions[j].receiptGroupId === groupId
    ) {
      j += 1;
    }
    const group = transactions.slice(i, j);
    const plan = planReceiptGroup(group);

    if (plan.mode === "aggregate") {
      result.push({
        date: group[0].date,
        description: plan.storeName,
        amount: plan.totalAmount,
        source: group[0].source,
        categoryId: plan.categoryId,
        categoryName: plan.categoryName,
        categoryColor:
          group.find((g) => g.categoryId === plan.categoryId)?.categoryColor ??
          null,
        receiptGroupId: plan.receiptGroupId,
        storeName: plan.storeName,
        itemName: null,
        memo: buildReceiptItemsMemo(group, plan.storeName, plan.receiptGroupId),
      });
    } else {
      for (const item of group) {
        result.push(item);
      }
    }

    i = j;
  }

  return result;
}

/** UI 用: グループID → 登録プラン */
export function buildReceiptGroupPlans(
  transactions: ParsedTransaction[]
): Map<string, ReceiptGroupPlan> {
  const plans = new Map<string, ReceiptGroupPlan>();
  let i = 0;
  while (i < transactions.length) {
    const groupId = transactions[i].receiptGroupId;
    if (!groupId) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (
      j < transactions.length &&
      transactions[j].receiptGroupId === groupId
    ) {
      j += 1;
    }
    plans.set(groupId, planReceiptGroup(transactions.slice(i, j)));
    i = j;
  }
  return plans;
}
