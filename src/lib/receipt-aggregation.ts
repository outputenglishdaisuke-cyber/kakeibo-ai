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
    }
  | {
      mode: "split";
      receiptGroupId: string;
      storeName: string;
      itemCount: number;
      totalAmount: number;
      reason: "mixed_categories" | "uncategorized" | "single_item";
    };

function resolveStoreName(group: ConfirmableTransaction[]): string {
  const fromField = group.find((g) => g.storeName?.trim())?.storeName?.trim();
  if (fromField) return fromField;
  const fromDesc = group[0]?.description?.split(" / ")[0]?.trim();
  return fromDesc || "レシート";
}

function isReceiptLineItem(tx: ConfirmableTransaction): boolean {
  return Boolean(tx.receiptGroupId && (tx.itemName || tx.storeName));
}

/**
 * 同一レシート内のカテゴリを見て、まとめ登録か品目分割かを決める。
 * - 全品が同一カテゴリ（かつ未分類なし）→ aggregate
 * - 未分類が1件でもある / カテゴリが複数 → split
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

  const categoryIds = group.map((g) => g.categoryId ?? null);
  if (categoryIds.some((id) => !id)) {
    return {
      mode: "split",
      receiptGroupId,
      storeName,
      itemCount,
      totalAmount,
      reason: "uncategorized",
    };
  }

  const unique = new Set(categoryIds as string[]);
  if (unique.size === 1) {
    const categoryId = categoryIds[0] as string;
    return {
      mode: "aggregate",
      receiptGroupId,
      storeName,
      categoryId,
      categoryName: group.find((g) => g.categoryId === categoryId)?.categoryName ?? null,
      itemCount,
      totalAmount,
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
