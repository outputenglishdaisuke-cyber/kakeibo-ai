import type { Prisma } from "@/generated/prisma";

/** 一覧・集計のデフォルト条件（集約で退避した旧品目・削除した Unknown は除外） */
export const activeTransactionWhere: Prisma.TransactionWhereInput = {
  archived: false,
  deletedAt: null,
};

/**
 * 支出として数える条件。突合済みのカード明細はレシート側（内訳）で数えるため除外する。
 * reconcile.ts の countsTowardTotals と同じ規則。
 */
export const countedTransactionWhere: Prisma.TransactionWhereInput = {
  ...activeTransactionWhere,
  NOT: { source: "CSV", reconcileStatus: "matched" },
};

export function withActiveTransactions(
  where: Prisma.TransactionWhereInput = {}
): Prisma.TransactionWhereInput {
  return {
    AND: [activeTransactionWhere, where],
  };
}

export function withCountedTransactions(
  where: Prisma.TransactionWhereInput = {}
): Prisma.TransactionWhereInput {
  return {
    AND: [countedTransactionWhere, where],
  };
}
