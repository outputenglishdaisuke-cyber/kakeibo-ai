/**
 * 既存データにカード明細とレシートの突合を適用する一度きりスクリプト（通常ロジックとは別管理）。
 *
 * ドライラン（書き込みなし。マイグレーション前の DB でも動く）:
 *   npx tsx --env-file=.env.local scripts/reconcile-existing.ts
 *   npx tsx --env-file=.env.local scripts/reconcile-existing.ts --ai   # 店名の未判定の組を AI（Web 検索）で判定
 *
 * 本実行（マイグレーション適用後のみ。実行前に全件バックアップを自動作成）:
 *   npx tsx --env-file=.env.local scripts/reconcile-existing.ts --apply
 *
 * 店名の AI 判定結果は backups/store-judgements-*.json に保存し、次回以降と --apply で再利用する。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { parseReceiptItemsMemo } from "../src/lib/receipt-aggregation";
import {
  applyReconcileToRows,
  buildReceiptUnits,
  cardCoverage,
  countsTowardTotals,
  finalizeUnmatchedReceiptsAsCash,
  isLegacyLineItem,
  matchCardAndReceipts,
  planInitialReconcileState,
  storeNameOf,
  toCardTransaction,
  type LedgerRow,
  type StoreJudge,
} from "../src/lib/reconcile";
import { compareStoreNames, normalizeStoreName } from "../src/lib/store-name";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const useAi = args.has("--ai");

/** 6月の IMAGE 単独行はカード明細の画像とみられるため、現金への自動判定から除外する（ユーザー確認済み） */
const EXEMPT_IMAGE_BEFORE = "2026-07-01";

const BACKUP_DIR = path.join(process.cwd(), "backups");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

type Judgement = {
  cardSample: string;
  receiptSample: string;
  verdict: "same" | "different" | "undetermined";
  source: "ai" | "user";
  confidence: number | null;
  merchant: string | null;
  reason: string | null;
};

type RawRow = {
  id: string;
  date: Date;
  description: string;
  amount: number;
  source: "CSV" | "MANUAL" | "IMAGE";
  categoryId: string | null;
  memo: string | null;
  confirmed: boolean;
  archived: boolean;
};

async function hasReconcileColumns(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM information_schema.columns
     WHERE table_name = 'Transaction' AND column_name = 'reconcileStatus'`
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function loadRows(): Promise<RawRow[]> {
  // マイグレーション前でも動くよう、既存カラムだけを読む
  return prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT id, date, description, amount, source::text AS source, "categoryId", memo, confirmed, archived
     FROM "Transaction" ORDER BY date ASC, id ASC`
  );
}

async function loadCachedJudgements(): Promise<Judgement[]> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const files = (await readdir(BACKUP_DIR)).filter((f) => f.startsWith("store-judgements-")).sort();
  const latest = files.at(-1);
  if (!latest) return [];
  return JSON.parse(await readFile(path.join(BACKUP_DIR, latest), "utf8")).judgements;
}

function judgementKey(cardName: string, receiptName: string) {
  return `${normalizeStoreName(cardName)}\u0000${normalizeStoreName(receiptName)}`;
}

function makeJudge(judgements: Judgement[]): StoreJudge {
  const map = new Map(judgements.map((j) => [judgementKey(j.cardSample, j.receiptSample), j]));
  return (cardName, receiptName) => {
    const a = normalizeStoreName(cardName);
    if (a && a === normalizeStoreName(receiptName)) return "same";
    return map.get(judgementKey(cardName, receiptName))?.verdict ?? "pending";
  };
}

function monthOf(date: string) {
  return date.slice(0, 7);
}

function monthlyTotals(rows: LedgerRow[], counts: (r: LedgerRow) => boolean) {
  const out: Record<string, { total: number; cash: number }> = {};
  for (const r of rows) {
    if (!counts(r)) continue;
    const m = (out[monthOf(r.date)] ??= { total: 0, cash: 0 });
    m.total += r.amount;
    if (r.reconcileStatus === "cash") m.cash += r.amount;
  }
  return out;
}

async function main() {
  const migrated = await hasReconcileColumns();
  if (apply && !migrated) {
    throw new Error(
      "--apply にはマイグレーション（20261003120000_add_card_receipt_reconciliation）の適用が必要です"
    );
  }

  const raw = await loadRows();
  const ledger: LedgerRow[] = raw.map((r) => ({
    id: r.id,
    date: r.date.toISOString().slice(0, 10),
    description: r.description,
    amount: r.amount,
    source: r.source,
    categoryId: r.categoryId,
    memo: r.memo,
    confirmed: r.confirmed,
    archived: r.archived,
    deletedAt: null,
    paymentMethod: null,
    reconcileStatus: "unmatched",
    cashSource: null,
    needsReview: false,
    receiptGroupId: null,
    matchedReceiptId: null,
    matchedCardId: null,
    autoCashExempt: false,
    rejectedCardIds: [],
  }));

  // 1. 初期値（現金と判別できる既存データは無いため cashIds は空。調査結果どおり）
  const active = ledger.filter((r) => !r.archived && r.confirmed !== false);
  const exemptIds = new Set(
    active
      .filter(
        (r) =>
          r.source === "IMAGE" &&
          r.date < EXEMPT_IMAGE_BEFORE &&
          !parseReceiptItemsMemo(r.memo) &&
          !isLegacyLineItem(r)
      )
      .map((r) => r.id)
  );
  const initialized = ledger.map((r) => ({
    ...r,
    ...planInitialReconcileState(r, { cashIds: new Set(), cardReceiptIds: new Set(), exemptIds }),
  }));

  // 2. 突合（店名は保存済み判定 → 無ければ AI）
  const cardRows = initialized.filter((r) => r.source === "CSV" && !r.archived);
  const cards = cardRows.map(toCardTransaction);
  const { units, legacyLineItems } = buildReceiptUnits(initialized);
  let judgements = await loadCachedJudgements();
  let result = matchCardAndReceipts(cards, units, { judgeStore: makeJudge(judgements) });

  if (useAi && result.unresolvedPairs.length > 0) {
    const { judgeStorePairsWithAi } = await import("../src/lib/store-match-ai");
    const toAsk = new Map<string, { cardName: string; receiptName: string }>();
    for (const p of result.unresolvedPairs) {
      toAsk.set(judgementKey(p.cardName, p.receiptName), {
        cardName: p.cardName,
        receiptName: p.receiptName,
      });
    }
    const examples = judgements
      .filter((j) => j.source === "user" && j.verdict !== "undetermined")
      .map((j) => ({
        cardName: j.cardSample,
        receiptName: j.receiptSample,
        verdict: j.verdict as "same" | "different",
        note: j.reason,
      }));
    const answers = await judgeStorePairsWithAi([...toAsk.values()], examples);
    const byKey = new Map(judgements.map((j) => [judgementKey(j.cardSample, j.receiptSample), j]));
    for (const a of answers) {
      const key = judgementKey(a.cardName, a.receiptName);
      if (byKey.get(key)?.source === "user") continue;
      byKey.set(key, {
        cardSample: a.cardName,
        receiptSample: a.receiptName,
        verdict: a.verdict,
        source: "ai",
        confidence: a.confidence,
        merchant: a.merchant,
        reason: a.reason,
      });
    }
    judgements = [...byKey.values()];
    const file = path.join(BACKUP_DIR, `store-judgements-${stamp()}.json`);
    await writeFile(file, JSON.stringify({ savedAt: new Date().toISOString(), judgements }, null, 2));
    console.error(`AI 判定結果を保存しました: ${file}`);
    result = matchCardAndReceipts(cards, units, { judgeStore: makeJudge(judgements) });
  }

  // 3. 現金への自動判定（カード明細CSVの期間内に限定）
  const coverage = cardCoverage(cardRows.map((r) => r.date));
  const finalized = finalizeUnmatchedReceiptsAsCash(result.receipts, coverage, {
    unresolvedPairs: result.unresolvedPairs,
  });
  const after = applyReconcileToRows(initialized, units, result.matches, finalized.finalizedIds);

  const unitById = new Map(units.map((u) => [u.id, u]));
  const rowById = new Map(after.map((r) => [r.id, r]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const describeUnit = (id: string) => {
    const u = unitById.get(id)!;
    return { date: u.date, storeName: u.storeName, amount: u.amount, rows: u.rowIds.length };
  };

  // 細分化される件数: 突合したレシートのうち、内訳が複数カテゴリのもの
  const splitCount = result.matches.filter((m) => {
    const u = unitById.get(m.receiptId)!;
    const cats = new Set<string | null>();
    for (const id of u.rowIds) {
      const r = rowById.get(id)!;
      const memo = parseReceiptItemsMemo(r.memo);
      if (memo) memo.items.forEach((i) => cats.add(i.categoryId ?? null));
      else cats.add(r.categoryId ?? null);
    }
    return cats.size > 1;
  }).length;

  const before = monthlyTotals(ledger, (r) => !r.archived && r.confirmed !== false);
  const afterTotals = monthlyTotals(after, countsTowardTotals);
  const months = [...new Set([...Object.keys(before), ...Object.keys(afterTotals)])].sort();

  const nonCard = after.filter((r) => r.source !== "CSV" && !r.archived);
  const report = {
    mode: apply ? "apply" : "dry-run",
    migrationApplied: migrated,
    coverage,
    classification: {
      note: "支払方法を示すデータが無いため、現金・カードと判別できた既存データは0件",
      csvCardStatements: cardRows.length,
      receiptsAndManual: {
        cash: nonCard.filter((r) => r.paymentMethod === "cash" && r.cashSource === "confirmed").length,
        creditCard: nonCard.filter((r) => r.paymentMethod === "credit_card").length,
        unknown: nonCard.filter((r) => r.paymentMethod === "unknown").length,
      },
      unknownNegativeRows: after
        .filter((r) => !r.archived && r.reconcileStatus === "unknown")
        .map((r) => ({ date: r.date, source: r.source, description: r.description, amount: r.amount })),
      autoCashExempt: [...exemptIds].map((id) => {
        const r = rowById.get(id)!;
        return { date: r.date, description: r.description, amount: r.amount };
      }),
      receiptUnits: units.length,
      legacyLineItemsExcluded: legacyLineItems.length,
    },
    matches: result.matches.map((m) => ({
      card: { date: m.cardDate, storeName: cardById.get(m.cardId)!.storeName, amount: cardById.get(m.cardId)!.amount },
      receipt: describeUnit(m.receiptId),
      dateDiffDays: m.dateDiffDays,
      needsReview: m.needsReview,
    })),
    needsReview: result.matches.filter((m) => m.needsReview).length,
    unresolvedStorePairs: result.unresolvedPairs.map((p) => ({
      card: p.cardName,
      receipt: p.receiptName,
      verdict: p.verdict,
      amount: cardById.get(p.cardId)!.amount,
    })),
    autoCash: finalized.finalizedIds.map(describeUnit),
    unmatchedCards: result.cards.filter((c) => c.status === "unmatched").length,
    unmatchedReceipts: finalized.receipts.filter((r) => r.status === "unmatched").length,
    splitByCategoryCount: splitCount,
    monthlyTotals: months.map((m) => ({
      month: m,
      before: before[m]?.total ?? 0,
      after: afterTotals[m]?.total ?? 0,
      diff: (afterTotals[m]?.total ?? 0) - (before[m]?.total ?? 0),
      cashAfter: afterTotals[m]?.cash ?? 0,
    })),
    aiJudgements: judgements.map((j) => ({
      card: j.cardSample,
      receipt: j.receiptSample,
      verdict: j.verdict,
      confidence: j.confidence,
      merchant: j.merchant,
      reason: j.reason,
    })),
    storeNamePairs: buildStoreNamePairs(after, makeJudge(judgements)),
  };
  console.log(JSON.stringify(report, null, 2));

  if (!apply) return;

  // 4. 本実行: バックアップ → 1トランザクションで反映（元データは削除しない）
  await mkdir(BACKUP_DIR, { recursive: true });
  const backupRows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM "Transaction" ORDER BY date ASC, id ASC`
  );
  const backupFile = path.join(BACKUP_DIR, `transactions-pre-reconcile-${stamp()}.json`);
  await writeFile(backupFile, JSON.stringify({ count: backupRows.length, transactions: backupRows }, null, 2));
  console.error(`バックアップ: ${backupFile}（${backupRows.length}件）`);

  await prisma.$transaction(
    async (tx) => {
      for (const r of after) {
        if (r.archived) continue;
        await tx.transaction.update({
          where: { id: r.id },
          data: {
            paymentMethod: r.paymentMethod,
            reconcileStatus: r.reconcileStatus,
            cashSource: r.cashSource,
            needsReview: r.needsReview,
            matchedReceiptId: r.matchedReceiptId,
            matchedCardId: r.matchedCardId,
            autoCashExempt: r.autoCashExempt,
          },
        });
      }
      for (const j of judgements) {
        const cardName = normalizeStoreName(j.cardSample);
        const receiptName = normalizeStoreName(j.receiptSample);
        await tx.storeMatchJudgement.upsert({
          where: { cardName_receiptName: { cardName, receiptName } },
          create: { cardName, receiptName, ...j },
          update: j.source === "ai" ? {} : j,
        });
      }
    },
    { maxWait: 20_000, timeout: 180_000 }
  );
  console.error("本実行が完了しました");
}

/** カード側とレシート側の店名の対応（金額は問わない）。網羅確認用 */
function buildStoreNamePairs(rows: LedgerRow[], judge: StoreJudge) {
  const active = rows.filter((r) => !r.archived);
  const cardNames = [...new Set(active.filter((r) => r.source === "CSV").map((r) => r.description))];
  const receiptNames = [
    ...new Set(active.filter((r) => r.source !== "CSV").map((r) => storeNameOf(r.description))),
  ];
  return cardNames
    .map((card) => {
      const related = receiptNames
        .map((receipt) => ({
          receipt,
          verdict: judge(card, receipt),
          textSimilar: compareStoreNames(card, receipt).similar,
        }))
        .filter((x) => x.verdict === "same" || x.textSimilar);
      return { card, receipts: related };
    })
    .sort((a, b) => a.card.localeCompare(b.card, "ja"));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
