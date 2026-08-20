import type { Prisma } from "@/generated/prisma";

/** 一覧・集計のデフォルト条件（集約で退避した旧品目は除外） */
export const activeTransactionWhere: Prisma.TransactionWhereInput = {
  archived: false,
};

export function withActiveTransactions(
  where: Prisma.TransactionWhereInput = {}
): Prisma.TransactionWhereInput {
  return {
    AND: [activeTransactionWhere, where],
  };
}
