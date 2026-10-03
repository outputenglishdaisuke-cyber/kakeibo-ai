/**
 * カード明細とレシートの突合を DB に反映するサービス層。
 * 判定ロジックは reconcile.ts の純関数に置き、ここでは読み込み・永続化だけを行う。
 */
import type { Prisma, Transaction } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import {
  buildReceiptUnits,
  buildReconcileSummary,
  cardCoverage,
  diffDays,
  finalizeUnmatchedReceiptsAsCash,
  matchCardAndReceipts,
  storeNameOf,
  toCardTransaction,
  type LedgerRow,
  type ReceiptUnit,
  type StoreJudge,
} from "@/lib/reconcile";
import { compareStoreNames, normalizeStoreName } from "@/lib/store-name";

type Db = Prisma.TransactionClient | typeof prisma;

export function toLedgerRow(tx: Transaction): LedgerRow {
  return {
    id: tx.id,
    date: tx.date.toISOString().slice(0, 10),
    description: tx.description,
    amount: tx.amount,
    source: tx.source,
    categoryId: tx.categoryId,
    memo: tx.memo,
    confirmed: tx.confirmed,
    archived: tx.archived,
    deletedAt: tx.deletedAt,
    paymentMethod: tx.paymentMethod,
    reconcileStatus: tx.reconcileStatus,
    cashSource: tx.cashSource,
    needsReview: tx.needsReview,
    receiptGroupId: tx.receiptGroupId,
    matchedReceiptId: tx.matchedReceiptId,
    matchedCardId: tx.matchedCardId,
    autoCashExempt: tx.autoCashExempt,
    rejectedCardIds: tx.rejectedCardIds ?? [],
  };
}

async function loadLedger(db: Db = prisma): Promise<LedgerRow[]> {
  const rows = await db.transaction.findMany({
    where: { archived: false, deletedAt: null, confirmed: true },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  return rows.map(toLedgerRow);
}

function judgementKey(cardName: string, receiptName: string) {
  return `${normalizeStoreName(cardName)}\u0000${normalizeStoreName(receiptName)}`;
}

type JudgementRow = Awaited<ReturnType<typeof prisma.storeMatchJudgement.findMany>>[number];

async function loadJudgements(db: Db = prisma) {
  const rows = await db.storeMatchJudgement.findMany();
  return new Map(rows.map((r) => [`${r.cardName}\u0000${r.receiptName}`, r]));
}

/** 正規化後に同じ名前なら同じ店。それ以外は保存済みの判定（ユーザー優先）、無ければ未判定 */
export function makeStoreJudge(judgements: Map<string, JudgementRow>): StoreJudge {
  return (cardName, receiptName) => {
    const a = normalizeStoreName(cardName);
    const b = normalizeStoreName(receiptName);
    if (a && a === b) return "same";
    const j = judgements.get(`${a}\u0000${b}`);
    return j ? j.verdict : "pending";
  };
}

export interface ReconcileRunResult {
  matched: number;
  finalizedCash: number;
  aiJudgedPairs: number;
  unresolvedPairs: number;
}

/**
 * 突合を実行して DB に反映する。
 * - useAi: 未判定・AI判定不可の店名の組を AI（Web 検索つき）に問い合わせる（CSV取込完了時のみ）
 * - finalizeCash: 突合できなかったレシートを現金（auto）に倒す（CSV取込完了時のみ）
 */
export async function runReconciliation(options: {
  useAi: boolean;
  finalizeCash: boolean;
}): Promise<ReconcileRunResult> {
  const ledger = await loadLedger();
  const cardRows = ledger.filter((r) => r.source === "CSV");
  const cards = cardRows.map(toCardTransaction);
  const { units } = buildReceiptUnits(ledger);

  let judgements = await loadJudgements();
  let result = matchCardAndReceipts(cards, units, {
    judgeStore: makeStoreJudge(judgements),
  });

  let aiJudgedPairs = 0;
  if (options.useAi) {
    const toAsk = new Map<string, { cardName: string; receiptName: string }>();
    for (const p of result.unresolvedPairs) {
      const key = judgementKey(p.cardName, p.receiptName);
      const existing = judgements.get(key);
      if (existing?.source === "user") continue;
      toAsk.set(key, { cardName: p.cardName, receiptName: p.receiptName });
    }
    if (toAsk.size > 0) {
      const { judgeStorePairsWithAi } = await import("@/lib/store-match-ai");
      const examples = [...judgements.values()]
        .filter((j) => j.source === "user" && j.verdict !== "undetermined")
        .slice(-30)
        .map((j) => ({
          cardName: j.cardSample,
          receiptName: j.receiptSample,
          verdict: j.verdict as "same" | "different",
          note: j.reason,
        }));
      const answers = await judgeStorePairsWithAi([...toAsk.values()], examples);
      for (const a of answers) {
        await saveJudgement({
          cardSample: a.cardName,
          receiptSample: a.receiptName,
          verdict: a.verdict,
          source: "ai",
          confidence: a.confidence,
          merchant: a.merchant,
          reason: a.reason,
        });
      }
      aiJudgedPairs = answers.length;
      judgements = await loadJudgements();
      result = matchCardAndReceipts(cards, units, {
        judgeStore: makeStoreJudge(judgements),
      });
    }
  }

  let finalizedIds: string[] = [];
  if (options.finalizeCash) {
    const coverage = cardCoverage(cardRows.map((r) => r.date));
    finalizedIds = finalizeUnmatchedReceiptsAsCash(result.receipts, coverage, {
      unresolvedPairs: result.unresolvedPairs,
    }).finalizedIds;
  }

  const unitById = new Map(units.map((u) => [u.id, u]));
  await prisma.$transaction(async (tx) => {
    for (const m of result.matches) {
      const unit = unitById.get(m.receiptId)!;
      await tx.transaction.update({
        where: { id: m.cardId },
        data: {
          reconcileStatus: "matched",
          matchedReceiptId: m.receiptId,
          needsReview: m.needsReview,
        },
      });
      await tx.transaction.updateMany({
        where: { id: { in: unit.rowIds } },
        data: {
          reconcileStatus: "matched",
          matchedCardId: m.cardId,
          needsReview: m.needsReview,
        },
      });
    }
    const cashRowIds = finalizedIds.flatMap((id) => unitById.get(id)?.rowIds ?? []);
    if (cashRowIds.length > 0) {
      await tx.transaction.updateMany({
        where: { id: { in: cashRowIds } },
        data: { reconcileStatus: "cash", paymentMethod: "cash", cashSource: "auto" },
      });
    }
  });

  return {
    matched: result.matches.length,
    finalizedCash: finalizedIds.length,
    aiJudgedPairs,
    unresolvedPairs: result.unresolvedPairs.length,
  };
}

export async function saveJudgement(input: {
  cardSample: string;
  receiptSample: string;
  verdict: "same" | "different" | "undetermined";
  source: "ai" | "user";
  confidence?: number | null;
  merchant?: string | null;
  reason?: string | null;
}) {
  const cardName = normalizeStoreName(input.cardSample);
  const receiptName = normalizeStoreName(input.receiptSample);
  const data = {
    cardSample: input.cardSample,
    receiptSample: input.receiptSample,
    verdict: input.verdict,
    source: input.source,
    confidence: input.confidence ?? null,
    merchant: input.merchant ?? null,
    reason: input.reason ?? null,
  };
  if (input.source === "ai") {
    const existing = await prisma.storeMatchJudgement.findUnique({
      where: { cardName_receiptName: { cardName, receiptName } },
    });
    if (existing?.source === "user") return existing;
  }
  return prisma.storeMatchJudgement.upsert({
    where: { cardName_receiptName: { cardName, receiptName } },
    create: { cardName, receiptName, ...data },
    update: data,
  });
}

/**
 * 指定行が関わる突合を解除する（削除・金額変更・手動解除の前に呼ぶ）。
 * rejectPair=true の場合、同じ組を次回以降に再突合しないよう記録する。
 */
export async function releaseLinks(
  rowIds: string[],
  options: { rejectPair: boolean },
  db: Db = prisma
): Promise<number> {
  if (rowIds.length === 0) return 0;
  const rows = await db.transaction.findMany({
    where: { id: { in: rowIds }, reconcileStatus: "matched" },
  });
  const cardIds = new Set<string>();
  for (const r of rows) {
    if (r.source === "CSV") cardIds.add(r.id);
    else if (r.matchedCardId) cardIds.add(r.matchedCardId);
  }
  for (const cardId of cardIds) {
    const receiptRows = await db.transaction.findMany({
      where: { matchedCardId: cardId },
    });
    for (const r of receiptRows) {
      await db.transaction.update({
        where: { id: r.id },
        data: {
          reconcileStatus: "unmatched",
          matchedCardId: null,
          needsReview: false,
          rejectedCardIds: options.rejectPair
            ? [...new Set([...(r.rejectedCardIds ?? []), cardId])]
            : r.rejectedCardIds,
        },
      });
    }
    await db.transaction.updateMany({
      where: { id: cardId },
      data: { reconcileStatus: "unmatched", matchedReceiptId: null, needsReview: false },
    });
  }
  return cardIds.size;
}

/** レシートの行IDを、同じレシート（receiptGroupId）の全行に広げる */
async function expandReceiptRows(ids: string[], db: Db = prisma): Promise<string[]> {
  const rows = await db.transaction.findMany({
    where: { id: { in: ids } },
    select: { id: true, receiptGroupId: true },
  });
  const groupIds = rows.map((r) => r.receiptGroupId).filter((g): g is string => !!g);
  if (groupIds.length === 0) return rows.map((r) => r.id);
  const grouped = await db.transaction.findMany({
    where: { receiptGroupId: { in: groupIds }, archived: false },
    select: { id: true },
  });
  return [...new Set([...rows.map((r) => r.id), ...grouped.map((r) => r.id)])];
}

/** 自動で現金にしたレシートを未突合に戻し、以後は自動で現金にしない */
export async function revertAutoCash(ids: string[]) {
  const rowIds = await expandReceiptRows(ids);
  return prisma.transaction.updateMany({
    where: { id: { in: rowIds }, reconcileStatus: "cash", cashSource: "auto" },
    data: {
      reconcileStatus: "unmatched",
      paymentMethod: "unknown",
      cashSource: null,
      autoCashExempt: true,
    },
  });
}

/** 返金・調整など判断できない明細を Unknown にまとめる（突合の対象外） */
export async function markUnknown(ids: string[]) {
  const rowIds = await expandReceiptRows(ids);
  return prisma.$transaction(async (tx) => {
    await releaseLinks(rowIds, { rejectPair: true }, tx);
    return tx.transaction.updateMany({
      where: { id: { in: rowIds } },
      data: { reconcileStatus: "unknown", needsReview: false },
    });
  });
}

/** Unknown の明細をソフト削除する（DB には残る） */
export async function deleteUnknown(ids: string[]) {
  return prisma.transaction.updateMany({
    where: { id: { in: ids }, reconcileStatus: "unknown", deletedAt: null },
    data: { deletedAt: new Date() },
  });
}

export async function unlinkMatch(cardId: string) {
  return prisma.$transaction((tx) => releaseLinks([cardId], { rejectPair: true }, tx));
}

type RowView = {
  id: string;
  date: string;
  storeName: string;
  amount: number;
};

function unitView(u: ReceiptUnit): RowView & { rowCount: number } {
  return { id: u.rowIds[0], date: u.date, storeName: u.storeName, amount: u.amount, rowCount: u.rowIds.length };
}

/** 照合画面のデータ（月単位） */
export async function getReconcileView(month: string) {
  const [ledger, judgements] = await Promise.all([loadLedger(), loadJudgements()]);
  const inMonth = (date: string) => date.startsWith(month);
  const monthRows = ledger.filter((r) => inMonth(r.date));
  const cardRows = ledger.filter((r) => r.source === "CSV");
  const { units, legacyLineItems } = buildReceiptUnits(ledger);
  const unitByRowId = new Map(units.flatMap((u) => u.rowIds.map((id) => [id, u] as const)));
  const judge = makeStoreJudge(judgements);

  const unmatchedCards = cardRows.filter(
    (r) => inMonth(r.date) && r.reconcileStatus === "unmatched"
  );
  const openUnits = units.filter((u) => u.status === "unmatched");
  const autoCashUnits = units.filter((u) => u.status === "cash" && u.cashSource === "auto");

  const matchedPairs = cardRows
    .filter((r) => inMonth(r.date) && r.reconcileStatus === "matched")
    .map((card) => {
      const unit = units.find((u) => u.cardTransactionId === card.id);
      return {
        cardId: card.id,
        cardDate: card.date,
        cardStoreName: card.description,
        amount: card.amount,
        receiptDate: unit?.date ?? null,
        receiptStoreName: unit?.storeName ?? null,
        dateDiffDays: unit ? diffDays(card.date, unit.date) : null,
        needsReview: card.needsReview,
      };
    });

  const mismatchCandidates = unmatchedCards
    .flatMap((card) =>
      [...openUnits, ...autoCashUnits]
        .filter((u) => u.amount !== card.amount)
        .filter((u) => {
          const verdict = judge(card.description, u.storeName);
          if (verdict === "different") return false;
          return verdict === "same" || compareStoreNames(card.description, u.storeName).similar;
        })
        .map((u) => ({
          cardId: card.id,
          cardDate: card.date,
          cardStoreName: card.description,
          cardAmount: card.amount,
          receipt: unitView(u),
          receiptIsAutoCash: u.status === "cash",
          amountDiff: u.amount - card.amount,
          dateDiffDays: diffDays(card.date, u.date),
        }))
    )
    .sort((a, b) => Math.abs(a.dateDiffDays) - Math.abs(b.dateDiffDays))
    .slice(0, 30);

  const openCardNames = new Set(
    cardRows.filter((r) => r.reconcileStatus === "unmatched").map((r) => normalizeStoreName(r.description))
  );
  const openReceiptNames = new Set(openUnits.map((u) => normalizeStoreName(u.storeName)));
  const undeterminedPairs = [...judgements.values()]
    .filter(
      (j) =>
        j.verdict === "undetermined" &&
        openCardNames.has(j.cardName) &&
        openReceiptNames.has(j.receiptName)
    )
    .map((j) => ({
      cardSample: j.cardSample,
      receiptSample: j.receiptSample,
      merchant: j.merchant,
      reason: j.reason,
    }));

  const coverage = cardCoverage(cardRows.map((r) => r.date));

  return {
    month,
    coverage,
    summary: buildReconcileSummary(monthRows),
    unmatchedCards: unmatchedCards.map((r) => ({
      id: r.id,
      date: r.date,
      storeName: r.description,
      amount: r.amount,
    })),
    unmatchedReceipts: openUnits.filter((u) => inMonth(u.date)).map(unitView),
    autoCashReceipts: autoCashUnits.filter((u) => inMonth(u.date)).map(unitView),
    matchedPairs,
    mismatchCandidates,
    undeterminedPairs,
    unknownRows: monthRows
      .filter((r) => r.reconcileStatus === "unknown")
      .map((r) => ({
        id: r.id,
        date: r.date,
        storeName: storeNameOf(r.description),
        amount: r.amount,
        source: r.source,
        receiptUnitRows: unitByRowId.get(r.id)?.rowIds.length ?? 1,
      })),
    legacyLineItemCount: legacyLineItems.filter((r) => inMonth(r.date)).length,
  };
}

export type ReconcileView = Awaited<ReturnType<typeof getReconcileView>>;
