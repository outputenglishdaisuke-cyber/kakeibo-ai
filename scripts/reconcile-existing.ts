/**
 * 既存データに、利用日の窓・CSV取込単位の範囲・未照合の理由を使う突合を適用するスクリプト
 * （通常ロジックとは別管理。照合の判定そのものはアプリと同じ関数を使う）。
 *
 * ドライラン（書き込みなし。20261003140000_card_import_batches の適用前でも動く）:
 *   npx tsx --env-file=.env.local scripts/reconcile-existing.ts
 *
 * 本実行（マイグレーション適用後のみ。実行前に関連テーブルを全件バックアップ）:
 *   npx tsx --env-file=.env.local scripts/reconcile-existing.ts --apply
 *   --fix-wrong-matches を付けると、ドライランで一覧にした「日付差31日超の照合」を解除してから再突合する。
 *   ドライラン結果をユーザーが確認・承認するまでは付けないこと。
 *   --ai を付けると、店名の未判定の組を AI（Web 検索）に問い合わせる。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { parseReceiptItemsMemo } from "../src/lib/receipt-aggregation";
import {
  applyReconcileToRows,
  buildImportCoverages,
  buildReceiptUnits,
  countsTowardTotals,
  DEFAULT_MAX_DAYS,
  finalizeUnmatchedReceiptsAsCash,
  findOutOfRangeMatches,
  matchCardAndReceipts,
  storeNameOf,
  toCardTransaction,
  type LedgerRow,
  type StoreJudge,
} from "../src/lib/reconcile";
import {
  loadJudgements,
  makeStoreJudge,
  releaseLinks,
  runReconciliation,
} from "../src/lib/reconcile-service";
import {
  compareStoreNames,
  isFacilityTenant,
  normalizeStoreName,
  ruleBasedStoreVerdict,
  storeAliasGroup,
} from "../src/lib/store-name";
import { STORE_ALIAS_GROUPS, STORE_FACILITY_GROUPS } from "../src/lib/store-aliases";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const fixWrongMatches = args.has("--fix-wrong-matches");
const useAi = args.has("--ai");

const BACKUP_DIR = path.join(process.cwd(), "backups");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

type RawRow = {
  id: string;
  date: Date;
  createdAt: Date;
  description: string;
  amount: number;
  source: "CSV" | "MANUAL" | "IMAGE";
  categoryId: string | null;
  memo: string | null;
  confirmed: boolean;
  archived: boolean;
  deletedAt: Date | null;
  paymentMethod: LedgerRow["paymentMethod"];
  reconcileStatus: LedgerRow["reconcileStatus"];
  cashSource: LedgerRow["cashSource"];
  needsReview: boolean;
  receiptGroupId: string | null;
  matchedReceiptId: string | null;
  matchedCardId: string | null;
  autoCashExempt: boolean;
  rejectedCardIds: string[] | null;
  unmatchedReason: LedgerRow["unmatchedReason"];
  importBatchId: string | null;
};

async function columnsOf(table: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    table
  );
  return new Set(rows.map((r) => r.column_name));
}

/** マイグレーション前でも動くよう、存在するカラムだけを読む */
async function loadRows(columns: Set<string>): Promise<RawRow[]> {
  const optional = (name: string, fallback: string) =>
    columns.has(name) ? `"${name}"${name === "unmatchedReason" ? "::text" : ""}` : `${fallback} AS "${name}"`;
  return prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT id, date, "createdAt", description, amount, source::text AS source, "categoryId", memo,
            confirmed, archived, "deletedAt", "paymentMethod"::text AS "paymentMethod",
            "reconcileStatus"::text AS "reconcileStatus", "cashSource"::text AS "cashSource",
            "needsReview", "receiptGroupId", "matchedReceiptId", "matchedCardId", "autoCashExempt",
            "rejectedCardIds", ${optional("unmatchedReason", "NULL")}, ${optional("importBatchId", "NULL")}
     FROM "Transaction" ORDER BY date ASC, id ASC`
  );
}

function toLedger(r: RawRow): LedgerRow {
  return {
    id: r.id,
    date: r.date.toISOString().slice(0, 10),
    description: r.description,
    amount: r.amount,
    source: r.source,
    categoryId: r.categoryId,
    memo: r.memo,
    confirmed: r.confirmed,
    archived: r.archived,
    deletedAt: r.deletedAt,
    paymentMethod: r.paymentMethod,
    reconcileStatus: r.reconcileStatus,
    cashSource: r.cashSource,
    needsReview: r.needsReview,
    receiptGroupId: r.receiptGroupId,
    matchedReceiptId: r.matchedReceiptId,
    matchedCardId: r.matchedCardId,
    autoCashExempt: r.autoCashExempt,
    rejectedCardIds: r.rejectedCardIds ?? [],
    unmatchedReason: r.unmatchedReason ?? null,
    importBatchId: r.importBatchId,
  };
}

/**
 * 取込単位の記録が無い既存のCSV行を、取込時刻（分単位）でまとめて「以前の取込」とする。
 * ファイル名・支払月は記録が無いため推測しない（null のまま）。
 */
function planLegacyBatches(rows: RawRow[]) {
  const groups = new Map<string, RawRow[]>();
  for (const r of rows) {
    if (r.source !== "CSV" || r.importBatchId) continue;
    const key = r.createdAt.toISOString().slice(0, 16);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([minute, list], i) => {
    const dates = list.map((r) => r.date.toISOString().slice(0, 10)).sort();
    return {
      plannedId: `legacy-${i + 1}`,
      importedAt: `${minute}Z`,
      rowIds: list.map((r) => r.id),
      rowCount: list.length,
      from: dates[0],
      to: dates[dates.length - 1],
    };
  });
}

function judgeSource(
  judgements: Awaited<ReturnType<typeof loadJudgements>>,
  cardName: string,
  receiptName: string
) {
  const key = `${normalizeStoreName(cardName)}\u0000${normalizeStoreName(receiptName)}`;
  const j = judgements.get(key);
  if (j?.source === "user") return `user:${j.verdict}`;
  if (normalizeStoreName(cardName) === normalizeStoreName(receiptName)) return "rule:same_name";
  if (isFacilityTenant(cardName, receiptName)) return "rule:facility";
  const ga = storeAliasGroup(cardName);
  const gb = storeAliasGroup(receiptName);
  if (ga && gb) return ga === gb ? "rule:alias" : "rule:alias_different";
  const rule = ruleBasedStoreVerdict(cardName, receiptName);
  if (rule === "same") return "rule:text_similar";
  if (rule === "different") return "rule:facility_excluded";
  return j ? `ai:${j.verdict}` : "pending";
}

function monthlyTotals(rows: LedgerRow[]) {
  const out: Record<string, { total: number; card: number; cashConfirmed: number; cashAuto: number }> = {};
  for (const r of rows) {
    if (!countsTowardTotals(r)) continue;
    const m = (out[r.date.slice(0, 7)] ??= { total: 0, card: 0, cashConfirmed: 0, cashAuto: 0 });
    m.total += r.amount;
    if (r.reconcileStatus === "cash") {
      if (r.cashSource === "auto") m.cashAuto += r.amount;
      else m.cashConfirmed += r.amount;
    } else if (r.source === "CSV" || r.reconcileStatus === "matched") {
      m.card += r.amount;
    }
  }
  return out;
}

async function main() {
  const txColumns = await columnsOf("Transaction");
  const migratedV2 = txColumns.has("importBatchId") && txColumns.has("dupIndex");
  if (apply && !migratedV2) {
    throw new Error("--apply にはマイグレーション（20261003140000_card_import_batches）の適用が必要です");
  }
  if (fixWrongMatches && !apply) {
    throw new Error("--fix-wrong-matches は --apply と一緒に指定してください（ドライランでは一覧のみ表示します）");
  }

  const raw = await loadRows(txColumns);
  const existingBatches = migratedV2
    ? await prisma.cardImportBatch.findMany({ orderBy: { createdAt: "asc" } })
    : [];
  const legacyBatches = planLegacyBatches(raw);
  const plannedBatchOf = new Map(legacyBatches.flatMap((b) => b.rowIds.map((id) => [id, b.plannedId])));

  const ledgerAll = raw.map(toLedger).map((r) => ({
    ...r,
    importBatchId: r.importBatchId ?? plannedBatchOf.get(r.id) ?? null,
  }));
  const ledger = ledgerAll.filter((r) => !r.archived && !r.deletedAt && r.confirmed !== false);

  // 1. 日付差が31日を超える既存の照合（誤突合の候補）。承認があるまで解除しない
  const wrongMatches = findOutOfRangeMatches(ledger, DEFAULT_MAX_DAYS);
  const rowById = new Map(ledger.map((r) => [r.id, r]));

  // 2. 再突合のシミュレーション（--fix-wrong-matches を付けた場合と同じく、誤突合を解除した状態から）
  const wrongCardIds = new Set(wrongMatches.map((m) => m.cardId));
  const wrongReceiptRowIds = new Set(wrongMatches.flatMap((m) => m.receiptRowIds));
  const simulateFix = (rows: LedgerRow[]): LedgerRow[] =>
    rows.map((r) => {
      if (wrongCardIds.has(r.id)) {
        return { ...r, reconcileStatus: "unmatched", matchedReceiptId: null, needsReview: false };
      }
      if (wrongReceiptRowIds.has(r.id)) {
        return {
          ...r,
          reconcileStatus: "unmatched",
          matchedCardId: null,
          needsReview: false,
          rejectedCardIds: [...new Set([...r.rejectedCardIds, r.matchedCardId!])],
        };
      }
      return r;
    });

  const judgements = await loadJudgements();
  const judge: StoreJudge = makeStoreJudge(judgements);

  const simulate = (base: LedgerRow[]) => {
    const cardRows = base.filter((r) => r.source === "CSV");
    const cards = cardRows.map(toCardTransaction);
    const { units, legacyLineItems } = buildReceiptUnits(base);
    const result = matchCardAndReceipts(cards, units, { judgeStore: judge });
    const finalized = finalizeUnmatchedReceiptsAsCash(result.receipts, buildImportCoverages(cardRows), {
      unresolvedPairs: result.unresolvedPairs,
      taxCandidatePairs: result.taxCandidatePairs,
    });
    const after = applyReconcileToRows(base, units, result.matches, finalized.finalizedIds, finalized.receipts);
    return { cardRows, cards, units, legacyLineItems, result, finalized, after };
  };

  const keep = simulate(ledger);
  const fixed = wrongMatches.length > 0 ? simulate(simulateFix(ledger)) : keep;
  const plan = fixWrongMatches ? fixed : keep;
  const { cardRows, cards, units, legacyLineItems, result, finalized, after } = plan;

  const unitById = new Map(units.map((u) => [u.id, u]));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const afterById = new Map(after.map((r) => [r.id, r]));
  const describeUnit = (id: string) => {
    const u = unitById.get(id)!;
    return { date: u.date, storeName: u.storeName, amount: u.amount, rows: u.rowIds.length };
  };

  // 細分化される件数: 照合したレシートのうち、内訳が複数カテゴリのもの
  const splitCount = after
    .filter((r) => r.source === "CSV" && r.reconcileStatus === "matched" && r.matchedReceiptId)
    .filter((card) => {
      const u = unitById.get(card.matchedReceiptId!);
      if (!u) return false;
      const cats = new Set<string | null>();
      for (const id of u.rowIds) {
        const r = afterById.get(id)!;
        const memo = parseReceiptItemsMemo(r.memo);
        if (memo) memo.items.forEach((i) => cats.add(i.categoryId ?? null));
        else cats.add(r.categoryId ?? null);
      }
      return cats.size > 1;
    }).length;

  const before = monthlyTotals(ledger);
  const afterTotals = monthlyTotals(after);
  const months = [...new Set([...Object.keys(before), ...Object.keys(afterTotals)])].sort();

  const coverages = buildImportCoverages(cardRows);
  const coverageById = new Map(coverages.map((c) => [c.batchId, c]));
  const batchReport = [
    ...existingBatches.map((b) => ({
      id: b.id,
      fileName: b.fileName,
      paymentMonth: b.paymentMonth,
      importedAt: b.createdAt.toISOString(),
      planned: false,
    })),
    ...legacyBatches.map((b) => ({
      id: b.plannedId,
      fileName: null,
      paymentMonth: null,
      importedAt: b.importedAt,
      planned: true,
    })),
  ].map((b) => {
    const c = coverageById.get(b.id);
    return {
      ...b,
      fileName: b.fileName ?? "（記録なし。以前の取込のため推測しません）",
      rowCount: c?.count ?? 0,
      usageFrom: c?.from ?? null,
      usageTo: c?.to ?? null,
      cashJudgeSegments: c?.segments ?? [],
    };
  });

  const finalizedSet = new Set(finalized.finalizedIds);
  const nonCard = after.filter((r) => r.source !== "CSV");
  const existingAutoCash = units.filter((u) => u.status === "cash" && u.cashSource === "auto");
  const autoCashOutsideNewCoverage = existingAutoCash.filter(
    (u) =>
      !coverages.some((c) =>
        c.segments.some((s) => s.from <= u.date && u.date <= s.to)
      )
  );

  const unmatchedReceipts = finalized.receipts.filter(
    (r) => r.status === "unmatched" && !finalizedSet.has(r.id)
  );

  const report = {
    mode: apply ? (fixWrongMatches ? "apply+fix-wrong-matches" : "apply") : "dry-run",
    migrationApplied: { cardImportBatches: migratedV2 },
    importBatches: batchReport,
    wrongMatches: {
      note: "日付差が31日を超える既存の照合。承認後に --apply --fix-wrong-matches で解除して再突合します（自動では解除しません）",
      count: wrongMatches.length,
      items: wrongMatches.map((m) => ({
        card: {
          date: m.cardDate,
          storeName: rowById.get(m.cardId)?.description,
          amount: rowById.get(m.cardId)?.amount,
        },
        receipt: {
          date: m.receiptDate,
          storeName: storeNameOf(rowById.get(m.receiptRowIds[0])?.description ?? ""),
        },
        dateDiffDays: m.dateDiffDays,
      })),
      rematchIfFixed:
        wrongMatches.length > 0
          ? {
              newMatches: fixed.result.matches.length - keep.result.matches.length,
              autoCash: fixed.finalized.finalizedIds.length,
            }
          : null,
    },
    classification: {
      csvCardStatements: cardRows.length,
      receiptsAndManual: {
        cashConfirmed: nonCard.filter((r) => r.reconcileStatus === "cash" && r.cashSource === "confirmed").length,
        cashAuto: nonCard.filter((r) => r.reconcileStatus === "cash" && r.cashSource === "auto").length,
        creditCard: nonCard.filter((r) => r.paymentMethod === "credit_card").length,
        unknown: nonCard.filter((r) => r.paymentMethod === "unknown").length,
      },
      receiptUnits: units.length,
      legacyLineItemsExcluded: legacyLineItems.length,
    },
    newMatches: result.matches
      .filter((m) => rowById.get(m.cardId)?.reconcileStatus !== "matched")
      .map((m) => ({
        card: { date: m.cardDate, storeName: cardById.get(m.cardId)!.storeName, amount: cardById.get(m.cardId)!.amount },
        receipt: describeUnit(m.receiptId),
        dateDiffDays: m.dateDiffDays,
        needsReview: m.needsReview,
        storeRule: judgeSource(judgements, cardById.get(m.cardId)!.storeName, unitById.get(m.receiptId)!.storeName),
      })),
    needsReview: after.filter((r) => r.source === "CSV" && r.needsReview).length,
    unresolvedStorePairs: result.unresolvedPairs.map((p) => ({
      card: p.cardName,
      receipt: p.receiptName,
      verdict: p.verdict,
      amount: cardById.get(p.cardId)!.amount,
    })),
    taxExclusiveReceiptCandidates: {
      note: "カード金額がレシート金額の税込換算（8%〜10%）に当たる同じ店の組。税抜で読み取ったレシートの可能性が高いため、現金への自動判定から除外します",
      items: result.taxCandidatePairs.map((p) => ({
        card: {
          date: cardById.get(p.cardId)!.date,
          storeName: cardById.get(p.cardId)!.storeName,
          amount: cardById.get(p.cardId)!.amount,
        },
        receipt: describeUnit(p.receiptId),
      })),
    },
    autoCashPlanned: finalized.finalizedIds.map(describeUnit),
    existingAutoCashOutsideNewCoverage: {
      note: "以前の判定で現金(自動)になったが、新しい範囲の判定では対象外になるレシート。自動では戻しません",
      items: autoCashOutsideNewCoverage.map((u) => describeUnit(u.id)),
    },
    unmatchedCards: result.cards.filter((c) => c.status === "unmatched").length,
    unmatchedReceipts: {
      total: unmatchedReceipts.length,
      noCsvCoverage: unmatchedReceipts.filter((r) => r.unmatchedReason === "no_csv_coverage").length,
      noCandidate: unmatchedReceipts.filter((r) => r.unmatchedReason === "no_candidate").length,
      byMonth: Object.entries(
        unmatchedReceipts.reduce<Record<string, { no_csv_coverage: number; no_candidate: number }>>((acc, r) => {
          const m = (acc[r.date.slice(0, 7)] ??= { no_csv_coverage: 0, no_candidate: 0 });
          if (r.unmatchedReason) m[r.unmatchedReason] += 1;
          return acc;
        }, {})
      )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({ month, ...v })),
    },
    splitByCategoryCount: splitCount,
    monthlyTotals: months.map((m) => ({
      month: m,
      before: before[m]?.total ?? 0,
      after: afterTotals[m]?.total ?? 0,
      diff: (afterTotals[m]?.total ?? 0) - (before[m]?.total ?? 0),
      cardAfter: afterTotals[m]?.card ?? 0,
      cashConfirmedAfter: afterTotals[m]?.cashConfirmed ?? 0,
      cashAutoAfter: afterTotals[m]?.cashAuto ?? 0,
    })),
    storeNameCoverage: buildStoreNameCoverage(after, judgements),
  };
  console.log(JSON.stringify(report, null, 2));

  if (!apply) return;

  // 本実行: バックアップ → 取込単位の記録と誤突合の解除 → アプリと同じ突合処理（元データは削除しない）
  await mkdir(BACKUP_DIR, { recursive: true });
  const backup = {
    transactions: await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Transaction" ORDER BY date ASC, id ASC`
    ),
    cardImportBatches: await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "CardImportBatch"`),
    storeMatchJudgements: await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "StoreMatchJudgement"`
    ),
  };
  const backupFile = path.join(BACKUP_DIR, `pre-reconcile-v2-${stamp()}.json`);
  await writeFile(backupFile, JSON.stringify(backup, null, 2));
  console.error(`バックアップ: ${backupFile}（取引${backup.transactions.length}件）`);

  await prisma.$transaction(
    async (tx) => {
      for (const b of legacyBatches) {
        const batch = await tx.cardImportBatch.create({
          data: {
            fileName: null,
            format: null,
            paymentMonth: null,
            rowCount: b.rowCount,
            coverageStart: new Date(`${b.from}T00:00:00Z`),
            coverageEnd: new Date(`${b.to}T00:00:00Z`),
            createdAt: new Date(b.importedAt),
          },
        });
        await tx.transaction.updateMany({
          where: { id: { in: b.rowIds }, importBatchId: null },
          data: { importBatchId: batch.id },
        });
      }
      if (fixWrongMatches && wrongCardIds.size > 0) {
        await releaseLinks([...wrongCardIds], { rejectPair: true }, tx);
      }
    },
    { maxWait: 20_000, timeout: 120_000 }
  );

  const run = await runReconciliation({ useAi, finalizeCash: true });
  console.error(`本実行が完了しました: ${JSON.stringify(run)}`);
}

/** カード側の店名ごとに、同じ店と判定されるレシート側の店名と、その根拠（金額・日付は問わない） */
function buildStoreNameCoverage(rows: LedgerRow[], judgements: Awaited<ReturnType<typeof loadJudgements>>) {
  const cardNames = [...new Set(rows.filter((r) => r.source === "CSV").map((r) => r.description))];
  const receiptNames = [
    ...new Set(rows.filter((r) => r.source !== "CSV").map((r) => storeNameOf(r.description))),
  ];
  const pairs = cardNames
    .map((card) => ({
      card,
      receipts: receiptNames
        .map((receipt) => ({ receipt, rule: judgeSource(judgements, card, receipt) }))
        .filter(
          (x) =>
            x.rule.endsWith("same") ||
            (x.rule.startsWith("rule:") && !x.rule.endsWith("different") && x.rule !== "rule:facility_excluded") ||
            compareStoreNames(card, x.receipt).similar
        ),
    }))
    .filter((p) => p.receipts.length > 0)
    .sort((a, b) => a.card.localeCompare(b.card, "ja"));

  const allNames = [...cardNames, ...receiptNames];
  return {
    pairs,
    aliasGroupsUsed: STORE_ALIAS_GROUPS.map((g) => ({
      group: g.name,
      names: allNames.filter((n) => storeAliasGroup(n) === g.name),
    })),
    facilityGroupsUsed: STORE_FACILITY_GROUPS.map((f) => ({
      card: f.card,
      receipts: receiptNames.filter((r) => isFacilityTenant(f.card, r)),
    })),
    cardNamesWithoutReceiptCandidate: cardNames.filter((c) => !pairs.some((p) => p.card === c)).length,
  };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
