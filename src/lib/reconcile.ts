import { parseReceiptItemsMemo } from "@/lib/receipt-aggregation";
import {
  compareStoreNames,
  noAutoCashReason,
  ruleBasedStoreVerdict,
  type StoreSimilarityOptions,
} from "@/lib/store-name";

/** カード利用日とレシート日付の差がこの日数を超える組は、金額・店名が一致しても候補にしない */
export const DEFAULT_MAX_DAYS = 31;
/** 日付差がこの日数を超える突合は要確認にする */
export const DEFAULT_REVIEW_DAYS = 14;
/** 取込の最新利用日からこの日数以内のレシートは現金に倒さない */
export const DEFAULT_CASH_MARGIN_DAYS = 3;
/** 取込の利用日にこの日数以上の空白があれば、別の塊として扱う */
export const DEFAULT_COVERAGE_GAP_DAYS = 7;
/** 取込内でこの割合以下の明細しかない塊は、対象期間（現金への自動判定）から除く */
export const DEFAULT_COVERAGE_OUTLIER_SHARE = 0.1;

export type ReconcileStatus =
  | "unmatched"
  | "matched"
  | "fallback_split"
  | "cash"
  | "unknown";
export type PaymentMethod = "credit_card" | "cash" | "unknown";
export type CashSource = "confirmed" | "auto";
export type LedgerSource = "CSV" | "MANUAL" | "IMAGE";
/**
 * レシートが未突合の理由。
 * no_csv_coverage: 日付の前後（最大日数以内）に取込済みのカード明細が無い
 * no_candidate: 前後にカード明細はあるが、金額・店名の一致する候補が無い
 */
export type UnmatchedReason = "no_csv_coverage" | "no_candidate";

/** カード明細（親）。date は YYYY-MM-DD */
export interface CardTransaction {
  id: string;
  date: string;
  storeName: string;
  amount: number;
  status: ReconcileStatus;
  receiptId: string | null;
  needsReview?: boolean;
}

/** レシート1枚（子）。品目分割されたレシートは明細合計を amount に持つ */
export interface Receipt {
  id: string;
  date: string;
  storeName: string;
  amount: number;
  paymentMethod: PaymentMethod;
  status: ReconcileStatus;
  cashSource: CashSource | null;
  cardTransactionId: string | null;
  needsReview?: boolean;
  autoCashExempt?: boolean;
  /** 手動で紐付けを解除したカード明細。この組は再突合しない */
  rejectedCardIds?: string[];
  unmatchedReason?: UnmatchedReason | null;
}

/**
 * 店名が同じ店かの判定。
 * pending は「まだ判定していない」（AI に問い合わせる候補）、undetermined は「判定不可」。
 * どちらも突合は成立させない。
 */
export type StoreVerdict = "same" | "different" | "undetermined" | "pending";
export type StoreJudge = (cardName: string, receiptName: string) => StoreVerdict;

export interface MatchOptions {
  judgeStore?: StoreJudge;
  maxDays?: number;
  reviewDays?: number;
  similarity?: StoreSimilarityOptions;
}

export interface ReconcileMatch {
  cardId: string;
  receiptId: string;
  cardDate: string;
  receiptDate: string;
  /** レシート日付 − カード日付（日） */
  dateDiffDays: number;
  receiptAfterCard: boolean;
  similarity: number;
  needsReview: boolean;
}

export interface UnresolvedStorePair {
  cardId: string;
  receiptId: string;
  cardName: string;
  receiptName: string;
  verdict: "pending" | "undetermined";
}

export interface MatchResult {
  cards: CardTransaction[];
  receipts: Receipt[];
  matches: ReconcileMatch[];
  /** 金額は一致したが店名が未判定・判定不可の組 */
  unresolvedPairs: UnresolvedStorePair[];
  /** 同じ店・窓の内側で、カード金額がレシート金額の税込換算に当たる未突合の組（税抜で読み取ったレシートの可能性） */
  taxCandidatePairs: { cardId: string; receiptId: string }[];
}

/** 税抜の金額を税込（8%〜10%）にしたときに取りうる金額か。端数処理の差として前後1円を許す */
export function isTaxInclusiveAmount(receiptAmount: number, cardAmount: number): boolean {
  if (receiptAmount <= 0 || cardAmount <= receiptAmount) return false;
  return (
    cardAmount >= Math.floor(receiptAmount * 1.08) - 1 &&
    cardAmount <= Math.ceil(receiptAmount * 1.1) + 1
  );
}

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** b − a（日）。時刻・タイムゾーンに依存しない日付単位の差 */
export function diffDays(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** 別名辞書・施設名・文字列の類似度で判定する既定の店名判定（AI・ユーザーの判定は使わない） */
export function textStoreJudge(options: StoreSimilarityOptions = {}): StoreJudge {
  return (cardName, receiptName) =>
    ruleBasedStoreVerdict(cardName, receiptName, options) ?? "different";
}

export function isMatchableCard(card: CardTransaction): boolean {
  return card.status === "unmatched" && card.amount > 0;
}

export function isMatchableReceipt(receipt: Receipt): boolean {
  return (
    receipt.status === "unmatched" &&
    receipt.paymentMethod !== "cash" &&
    receipt.amount > 0
  );
}

/**
 * カード明細とレシートを 1対1 で突合する（純関数）。
 * 成立条件は「金額の完全一致」「同じ店の判定」「日付差が maxDays 以内」。
 * 候補の優先順: レシート日付<=カード日付 → 日付差の小さい順 → 店名類似度の高い順 → ID 昇順。
 * cards には突合済み・マイナス金額も含めて渡す（未突合の理由の判定に、取込済みの利用日を使う）。
 */
export function matchCardAndReceipts(
  cards: CardTransaction[],
  receipts: Receipt[],
  options: MatchOptions = {}
): MatchResult {
  const judge = options.judgeStore ?? textStoreJudge(options.similarity);
  const maxDays = options.maxDays ?? DEFAULT_MAX_DAYS;
  const reviewDays = options.reviewDays ?? DEFAULT_REVIEW_DAYS;

  type Candidate = ReconcileMatch & { receiptAfterRank: number; absDiff: number };
  const candidates: Candidate[] = [];
  const unresolvedPairs: UnresolvedStorePair[] = [];

  const openCards = cards.filter(isMatchableCard);
  const openReceipts = receipts.filter(isMatchableReceipt);

  for (const card of openCards) {
    for (const receipt of openReceipts) {
      if (card.amount !== receipt.amount) continue;
      if (Math.abs(diffDays(card.date, receipt.date)) > maxDays) continue;
      if (receipt.rejectedCardIds?.includes(card.id)) continue;

      const verdict = judge(card.storeName, receipt.storeName);
      if (verdict === "pending" || verdict === "undetermined") {
        unresolvedPairs.push({
          cardId: card.id,
          receiptId: receipt.id,
          cardName: card.storeName,
          receiptName: receipt.storeName,
          verdict,
        });
        continue;
      }
      if (verdict !== "same") continue;

      const dateDiffDays = diffDays(card.date, receipt.date);
      const receiptAfterCard = dateDiffDays > 0;
      const absDiff = Math.abs(dateDiffDays);
      candidates.push({
        cardId: card.id,
        receiptId: receipt.id,
        cardDate: card.date,
        receiptDate: receipt.date,
        dateDiffDays,
        receiptAfterCard,
        similarity: compareStoreNames(card.storeName, receipt.storeName, options.similarity)
          .score,
        needsReview: receiptAfterCard || absDiff > reviewDays,
        receiptAfterRank: receiptAfterCard ? 1 : 0,
        absDiff,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.receiptAfterRank - b.receiptAfterRank ||
      a.absDiff - b.absDiff ||
      b.similarity - a.similarity ||
      a.cardId.localeCompare(b.cardId) ||
      a.receiptId.localeCompare(b.receiptId)
  );

  const usedCards = new Set<string>();
  const usedReceipts = new Set<string>();
  const matches: ReconcileMatch[] = [];
  for (const c of candidates) {
    if (usedCards.has(c.cardId) || usedReceipts.has(c.receiptId)) continue;
    usedCards.add(c.cardId);
    usedReceipts.add(c.receiptId);
    matches.push({
      cardId: c.cardId,
      receiptId: c.receiptId,
      cardDate: c.cardDate,
      receiptDate: c.receiptDate,
      dateDiffDays: c.dateDiffDays,
      receiptAfterCard: c.receiptAfterCard,
      similarity: c.similarity,
      needsReview: c.needsReview,
    });
  }

  const taxCandidatePairs: MatchResult["taxCandidatePairs"] = [];
  for (const card of openCards) {
    if (usedCards.has(card.id)) continue;
    for (const receipt of openReceipts) {
      if (usedReceipts.has(receipt.id)) continue;
      if (!isTaxInclusiveAmount(receipt.amount, card.amount)) continue;
      if (Math.abs(diffDays(card.date, receipt.date)) > maxDays) continue;
      if (judge(card.storeName, receipt.storeName) !== "same") continue;
      taxCandidatePairs.push({ cardId: card.id, receiptId: receipt.id });
    }
  }

  const byCard = new Map(matches.map((m) => [m.cardId, m]));
  const byReceipt = new Map(matches.map((m) => [m.receiptId, m]));
  const cardDays = [...new Set(cards.map((c) => c.date.slice(0, 10)))];
  const reasonOf = (receipt: Receipt): UnmatchedReason =>
    cardDays.some((d) => Math.abs(diffDays(d, receipt.date)) <= maxDays)
      ? "no_candidate"
      : "no_csv_coverage";

  return {
    cards: cards.map((card) => {
      const m = byCard.get(card.id);
      return m
        ? { ...card, status: "matched", receiptId: m.receiptId, needsReview: m.needsReview }
        : card;
    }),
    receipts: receipts.map((receipt) => {
      const m = byReceipt.get(receipt.id);
      if (m) {
        return {
          ...receipt,
          status: "matched",
          cardTransactionId: m.cardId,
          needsReview: m.needsReview,
          unmatchedReason: null,
        };
      }
      if (isMatchableReceipt(receipt)) {
        return { ...receipt, unmatchedReason: reasonOf(receipt) };
      }
      return receipt;
    }),
    matches,
    unresolvedPairs: unresolvedPairs.filter(
      (p) => !usedCards.has(p.cardId) && !usedReceipts.has(p.receiptId)
    ),
    taxCandidatePairs,
  };
}

/** 利用日（YYYY-MM-DD）の連続した範囲 */
export interface CoverageSegment {
  from: string;
  to: string;
  count: number;
}

/** カードCSVの取込1回分の対象期間 */
export interface ImportCoverage {
  batchId: string;
  /** 利用日の最古・最新（表示用） */
  from: string;
  to: string;
  count: number;
  /** 現金への自動判定に使う期間。離れた少数の明細（例: 9月分のCSVに混ざる8/24のETC）は除く */
  segments: CoverageSegment[];
}

/**
 * 利用日の分布から対象期間を求める（純関数）。
 * gapDays 以上の空白で塊に分け、明細が outlierShare 以下しかない塊は除く（最大の塊は必ず残す）。
 */
export function coverageSegments(
  dates: string[],
  options: { gapDays?: number; outlierShare?: number } = {}
): CoverageSegment[] {
  const gapDays = options.gapDays ?? DEFAULT_COVERAGE_GAP_DAYS;
  const outlierShare = options.outlierShare ?? DEFAULT_COVERAGE_OUTLIER_SHARE;
  const sorted = dates.map((d) => d.slice(0, 10)).sort();
  if (sorted.length === 0) return [];

  const segments: CoverageSegment[] = [];
  let current: CoverageSegment = { from: sorted[0], to: sorted[0], count: 0 };
  for (const date of sorted) {
    if (diffDays(current.to, date) >= gapDays) {
      segments.push(current);
      current = { from: date, to: date, count: 0 };
    }
    current.to = date;
    current.count += 1;
  }
  segments.push(current);

  if (segments.length === 1) return segments;
  const largest = segments.reduce((a, b) => (b.count > a.count ? b : a));
  return segments.filter((s) => s === largest || s.count / sorted.length > outlierShare);
}

/** 取込ID が保存される前に取り込んだカード明細の取込キー */
export const LEGACY_BATCH_ID = "legacy";

/** カード明細を取込（importBatchId）ごとにまとめ、対象期間を求める。ID の無い既存明細は1つの取込とみなす */
export function buildImportCoverages(
  cards: { date: string; importBatchId?: string | null }[],
  options: { gapDays?: number; outlierShare?: number } = {}
): ImportCoverage[] {
  const byBatch = new Map<string, string[]>();
  for (const c of cards) {
    const key = c.importBatchId ?? LEGACY_BATCH_ID;
    byBatch.set(key, [...(byBatch.get(key) ?? []), c.date.slice(0, 10)]);
  }
  return [...byBatch].map(([batchId, dates]) => {
    const sorted = [...dates].sort();
    return {
      batchId,
      from: sorted[0],
      to: sorted[sorted.length - 1],
      count: sorted.length,
      segments: coverageSegments(sorted, options),
    };
  });
}
/**
 * 突合後も未突合のレシートを現金（auto）に倒す（純関数）。CSV取込の完了後にだけ呼ぶ。
 * 対象は、いずれかの取込の対象期間の内側にあり、その期間の最新利用日がレシート日付より
 * marginDays 以上後のレシートだけ。対象期間の外・no_csv_coverage のレシートは現金にしない。
 * 金額が一致するカード明細があり店名が未判定・判定不可のレシート（unresolvedPairs）と、
 * 同じ店にカード金額が税込換算に当たる明細があるレシート（taxCandidatePairs）も、
 * カード決済の可能性が高いため現金にしない（二重計上を防ぐ）。
 */
export function finalizeUnmatchedReceiptsAsCash(
  receipts: Receipt[],
  coverages: Pick<ImportCoverage, "segments">[],
  options: {
    marginDays?: number;
    unresolvedPairs?: Pick<UnresolvedStorePair, "receiptId">[];
    taxCandidatePairs?: { receiptId: string }[];
  } = {}
): { receipts: Receipt[]; finalizedIds: string[] } {
  const margin = options.marginDays ?? DEFAULT_CASH_MARGIN_DAYS;
  const segments = coverages.flatMap((c) => c.segments);
  const awaitingJudgement = new Set(
    [...(options.unresolvedPairs ?? []), ...(options.taxCandidatePairs ?? [])].map((p) => p.receiptId)
  );
  const covered = (date: string) =>
    segments.some((s) => date >= s.from && date <= s.to && diffDays(date, s.to) >= margin);

  const finalizedIds: string[] = [];
  const next = receipts.map((receipt) => {
    const target =
      receipt.status === "unmatched" &&
      receipt.paymentMethod !== "cash" &&
      receipt.unmatchedReason !== "no_csv_coverage" &&
      !receipt.autoCashExempt &&
      !noAutoCashReason(receipt.storeName) &&
      !awaitingJudgement.has(receipt.id) &&
      covered(receipt.date.slice(0, 10));
    if (!target) return receipt;
    finalizedIds.push(receipt.id);
    return {
      ...receipt,
      paymentMethod: "cash" as const,
      status: "cash" as const,
      cashSource: "auto" as const,
      unmatchedReason: null,
    };
  });
  return { receipts: next, finalizedIds };
}

/** 既に紐付いている組のうち、日付差が maxDays を超えるもの（誤突合の是正対象。自動では解除しない） */
export function findOutOfRangeMatches(
  rows: Pick<LedgerRow, "id" | "source" | "date" | "reconcileStatus" | "matchedCardId">[],
  maxDays = DEFAULT_MAX_DAYS
): { cardId: string; receiptRowIds: string[]; cardDate: string; receiptDate: string; dateDiffDays: number }[] {
  const cardById = new Map(rows.filter((r) => r.source === "CSV").map((r) => [r.id, r]));
  const byCard = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.source === "CSV" || r.reconcileStatus !== "matched" || !r.matchedCardId) continue;
    byCard.set(r.matchedCardId, [...(byCard.get(r.matchedCardId) ?? []), r]);
  }
  return [...byCard]
    .map(([cardId, receiptRows]) => {
      const cardDate = cardById.get(cardId)?.date ?? "";
      const receiptDate = receiptRows[0].date;
      return {
        cardId,
        receiptRowIds: receiptRows.map((r) => r.id),
        cardDate,
        receiptDate,
        dateDiffDays: cardDate ? diffDays(cardDate, receiptDate) : Number.NaN,
      };
    })
    .filter((m) => !Number.isFinite(m.dateDiffDays) || Math.abs(m.dateDiffDays) > maxDays);
}

function formatDay(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return `${y}/${m}/${d}`;
}

/**
 * CSV取込の利用日の範囲を説明する（純関数）。月・期間は利用日だけから決め、
 * ファイル名の年月（例: 202610）や支払月は使わない。ファイル名に年月があれば支払月である旨を添える。
 * 未突合のレシートの日付とまったく重ならない場合は warning を返す。
 */
export function describeImportCoverage(input: {
  fileName?: string | null;
  paymentMonth?: string | null;
  dates: string[];
  unmatchedReceiptDates?: string[];
}): { from: string; to: string; message: string; warning: string | null } | null {
  const sorted = input.dates.map((d) => d.slice(0, 10)).sort();
  if (sorted.length === 0) return null;
  const from = sorted[0];
  const to = sorted[sorted.length - 1];

  const label = input.fileName ? `「${input.fileName}」` : "このCSV";
  const fileMonth = input.fileName?.match(/(20\d{2})(0[1-9]|1[0-2])/)?.[0] ?? null;
  const note = fileMonth
    ? `（ファイル名の${fileMonth}は支払月で、利用月ではありません）`
    : input.paymentMonth
      ? `（支払月 ${input.paymentMonth.replace("-", "年")}月）`
      : "";
  const message = `${label}の利用日は ${formatDay(from)}〜${formatDay(to)} です${note}`;

  const receipts = (input.unmatchedReceiptDates ?? []).map((d) => d.slice(0, 10)).sort();
  let warning: string | null = null;
  if (receipts.length > 0) {
    const rFrom = receipts[0];
    const rTo = receipts[receipts.length - 1];
    if (rTo < from || rFrom > to) {
      warning = `未照合のレシート（${formatDay(rFrom)}〜${formatDay(rTo)}）とは期間が重ならないため、${label}の明細とは照合されません`;
    }
  }
  return { from, to, message, warning };
}

/**
 * CSV取込の重複判定用に、同じ日付・店名・金額の何件目かを振る（純関数）。
 * 同じファイルを再取込すると同じ番号になり、同日・同店・同額の明細が複数あっても取りこぼさない。
 */
export function assignDuplicateIndexes<T extends { date: string; description: string; amount: number }>(
  rows: T[]
): (T & { dupIndex: number })[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = `${row.date.slice(0, 10)}\u0000${row.description}\u0000${row.amount}`;
    const dupIndex = seen.get(key) ?? 0;
    seen.set(key, dupIndex + 1);
    return { ...row, dupIndex };
  });
}

/**
 * 保存時の突合関連の初期値。
 * マイナス金額（返金・調整）は Unknown、現金と分かっているレシートは cash(confirmed)。
 */
export function initialReconcileFields(
  source: LedgerSource,
  amount: number,
  paymentMethod?: PaymentMethod | null
): {
  paymentMethod: PaymentMethod | null;
  reconcileStatus: ReconcileStatus;
  cashSource: CashSource | null;
} {
  const method = source === "CSV" ? null : paymentMethod ?? "unknown";
  if (amount < 0) {
    return { paymentMethod: method, reconcileStatus: "unknown", cashSource: null };
  }
  if (method === "cash") {
    return { paymentMethod: "cash", reconcileStatus: "cash", cashSource: "confirmed" };
  }
  return { paymentMethod: method, reconcileStatus: "unmatched", cashSource: null };
}

/**
 * 既存データの初期値（移行スクリプト用）。
 * - 現金と判別できた行（cashIds）: cash / confirmed（突合の対象外）
 * - マイナス金額: Unknown
 * - それ以外のレシート・手入力: unknown / unmatched、カード明細: unmatched
 * - exemptIds: 現金への自動判定から除外（カード明細の画像など）
 */
export function planInitialReconcileState(
  row: Pick<LedgerRow, "id" | "source" | "amount">,
  sets: { cashIds?: Set<string>; cardReceiptIds?: Set<string>; exemptIds?: Set<string> } = {}
): Pick<LedgerRow, "paymentMethod" | "reconcileStatus" | "cashSource" | "autoCashExempt"> {
  const known: PaymentMethod | null =
    row.source === "CSV"
      ? null
      : sets.cashIds?.has(row.id)
        ? "cash"
        : sets.cardReceiptIds?.has(row.id)
          ? "credit_card"
          : "unknown";
  return {
    ...initialReconcileFields(row.source, row.amount, known),
    autoCashExempt: sets.exemptIds?.has(row.id) ?? false,
  };
}

/** DB 行のうち突合・集計に必要な項目 */
export interface LedgerRow {
  id: string;
  date: string;
  description: string;
  amount: number;
  source: LedgerSource;
  categoryId?: string | null;
  memo?: string | null;
  confirmed?: boolean;
  archived?: boolean;
  deletedAt?: string | Date | null;
  paymentMethod: PaymentMethod | null;
  reconcileStatus: ReconcileStatus;
  cashSource: CashSource | null;
  needsReview: boolean;
  receiptGroupId: string | null;
  matchedReceiptId: string | null;
  matchedCardId: string | null;
  autoCashExempt: boolean;
  rejectedCardIds: string[];
  unmatchedReason?: UnmatchedReason | null;
  importBatchId?: string | null;
  /** 二重登録などで集計から外した理由（null 以外は集計・突合の対象外） */
  excludedReason?: string | null;
  /** 手動の紐付けの単位（1枚のレシートと複数のカード明細など） */
  linkId?: string | null;
  /** 楽観的な同時操作の検知に使う（ISO 文字列） */
  updatedAt?: string;
}

export function isActiveRow(
  row: Pick<LedgerRow, "archived" | "deletedAt" | "confirmed" | "excludedReason">
) {
  return !row.archived && !row.deletedAt && !row.excludedReason && row.confirmed !== false;
}

/** 金額を内訳側（レシート・カテゴリ別の内訳行）で数えるカード明細の状態 */
export const CARD_STATUSES_COUNTED_BY_BREAKDOWN: ReconcileStatus[] = ["matched", "fallback_split"];

/**
 * 集計に含めるか。突合済み・レシートなしで確定したカード明細は内訳側で数えるため除外する。
 * 現金・未照合のカード明細・未突合のレシート・Unknown はそのまま数える。
 */
export function countsTowardTotals(
  row: Pick<
    LedgerRow,
    "archived" | "deletedAt" | "confirmed" | "excludedReason" | "source" | "reconcileStatus"
  >
): boolean {
  if (!isActiveRow(row)) return false;
  return !(row.source === "CSV" && CARD_STATUSES_COUNTED_BY_BREAKDOWN.includes(row.reconcileStatus));
}

/** 店名部分（「店名 / 品目」の店名） */
export function storeNameOf(description: string): string {
  const idx = description.indexOf(" / ");
  return (idx > 0 ? description.slice(0, idx) : description).trim();
}

/** レシートIDが保存されていない旧形式の品目行（突合の対象外） */
export function isLegacyLineItem(row: LedgerRow): boolean {
  return (
    row.source === "IMAGE" &&
    !row.receiptGroupId &&
    row.description.includes(" / ") &&
    !parseReceiptItemsMemo(row.memo)
  );
}

export interface ReceiptUnit extends Receipt {
  rowIds: string[];
}

/**
 * レシート・手入力の行をレシート1枚単位にまとめる。
 * receiptGroupId がある行は同じIDでまとめて合計し、無い行は1行を1枚とみなす。
 * レシートIDが無い旧形式の品目行は推測でまとめず、legacyLineItems として返す。
 */
export function buildReceiptUnits(rows: LedgerRow[]): {
  units: ReceiptUnit[];
  legacyLineItems: LedgerRow[];
} {
  const units: ReceiptUnit[] = [];
  const legacyLineItems: LedgerRow[] = [];
  const groups = new Map<string, LedgerRow[]>();

  for (const row of rows) {
    if (row.source === "CSV" || !isActiveRow(row)) continue;
    if (row.receiptGroupId) {
      const list = groups.get(row.receiptGroupId) ?? [];
      list.push(row);
      groups.set(row.receiptGroupId, list);
    } else if (isLegacyLineItem(row)) {
      legacyLineItems.push(row);
    } else {
      units.push(toUnit(row.id, [row]));
    }
  }
  for (const [groupId, list] of groups) {
    units.push(toUnit(groupId, list));
  }
  return { units, legacyLineItems };
}

function toUnit(id: string, rows: LedgerRow[]): ReceiptUnit {
  const first = rows[0];
  return {
    id,
    rowIds: rows.map((r) => r.id),
    date: first.date,
    storeName: storeNameOf(first.description),
    amount: rows.reduce((s, r) => s + r.amount, 0),
    paymentMethod: first.paymentMethod ?? "unknown",
    status: first.reconcileStatus,
    cashSource: first.cashSource,
    cardTransactionId: first.matchedCardId,
    needsReview: first.needsReview,
    autoCashExempt: rows.some((r) => r.autoCashExempt),
    rejectedCardIds: [...new Set(rows.flatMap((r) => r.rejectedCardIds))],
    unmatchedReason: first.unmatchedReason ?? null,
  };
}

export function toCardTransaction(row: LedgerRow): CardTransaction {
  return {
    id: row.id,
    date: row.date,
    storeName: row.description,
    amount: row.amount,
    status: row.reconcileStatus,
    receiptId: row.matchedReceiptId,
    needsReview: row.needsReview,
  };
}

/**
 * 突合・現金判定の結果を行データに反映した新しい配列を返す（DB には書かない）。
 * receipts を渡すと、未突合のレシートに unmatchedReason を反映する。
 */
export function applyReconcileToRows(
  rows: LedgerRow[],
  units: ReceiptUnit[],
  matches: ReconcileMatch[],
  finalizedCashUnitIds: string[] = [],
  receipts: Receipt[] = []
): LedgerRow[] {
  const unitById = new Map(units.map((u) => [u.id, u]));
  const updates = new Map<string, Partial<LedgerRow>>();
  for (const receipt of receipts) {
    if (receipt.status !== "unmatched") continue;
    for (const id of unitById.get(receipt.id)?.rowIds ?? []) {
      updates.set(id, { unmatchedReason: receipt.unmatchedReason ?? null });
    }
  }
  for (const m of matches) {
    updates.set(m.cardId, {
      reconcileStatus: "matched",
      matchedReceiptId: m.receiptId,
      needsReview: m.needsReview,
    });
    for (const id of unitById.get(m.receiptId)?.rowIds ?? []) {
      updates.set(id, {
        reconcileStatus: "matched",
        matchedCardId: m.cardId,
        needsReview: m.needsReview,
        unmatchedReason: null,
      });
    }
  }
  for (const unitId of finalizedCashUnitIds) {
    for (const id of unitById.get(unitId)?.rowIds ?? []) {
      updates.set(id, {
        reconcileStatus: "cash",
        paymentMethod: "cash",
        cashSource: "auto",
        unmatchedReason: null,
      });
    }
  }
  return rows.map((row) => (updates.has(row.id) ? { ...row, ...updates.get(row.id) } : row));
}

type AmountCount = { amount: number; count: number };

export interface ReconcileSummary {
  /** 総支出 = card + cash + provisional + adjustment */
  total: number;
  card: number;
  cash: number;
  /** カード明細が未取込・未突合のため暫定で数えているレシート・手入力 */
  provisional: number;
  /** 返金・調整（Unknown） */
  adjustment: number;
  cardStatement: AmountCount;
  matched: AmountCount;
  /** レシートなしで確定したカード明細 */
  cardOnly: AmountCount;
  unmatchedCards: AmountCount;
  unmatchedReceipts: AmountCount;
  /** 未突合のレシートのうち、前後に取込済みのカード明細が無いもの */
  unmatchedNoCoverage: AmountCount;
  /** 未突合のレシートのうち、前後にカード明細はあるが候補が無いもの */
  unmatchedNoCandidate: AmountCount;
  cashConfirmed: AmountCount;
  cashAuto: AmountCount;
}

const seenKeys = new WeakMap<AmountCount, Set<string>>();

/** key を渡すと、同じ key（同じレシートの品目行）は件数を1件として数える */
function add(acc: AmountCount, amount: number, key?: string) {
  acc.amount += amount;
  if (key === undefined) {
    acc.count += 1;
    return;
  }
  const seen = seenKeys.get(acc) ?? new Set<string>();
  seenKeys.set(acc, seen);
  if (!seen.has(key)) {
    seen.add(key);
    acc.count += 1;
  }
}

/** 月などの範囲で絞った行から、照合画面のサマリーを作る */
export function buildReconcileSummary(rows: LedgerRow[]): ReconcileSummary {
  const zero = (): AmountCount => ({ amount: 0, count: 0 });
  const s: ReconcileSummary = {
    total: 0,
    card: 0,
    cash: 0,
    provisional: 0,
    adjustment: 0,
    cardStatement: zero(),
    matched: zero(),
    cardOnly: zero(),
    unmatchedCards: zero(),
    unmatchedReceipts: zero(),
    unmatchedNoCoverage: zero(),
    unmatchedNoCandidate: zero(),
    cashConfirmed: zero(),
    cashAuto: zero(),
  };

  for (const row of rows) {
    if (!isActiveRow(row)) continue;
    const isCard = row.source === "CSV";
    const status = row.reconcileStatus;

    if (isCard) {
      add(s.cardStatement, row.amount);
      if (status === "matched") add(s.matched, row.amount);
      if (status === "fallback_split") add(s.cardOnly, row.amount);
      if (status === "unmatched") add(s.unmatchedCards, row.amount);
    } else {
      const receiptKey = row.receiptGroupId ?? row.id;
      if (status === "unmatched") {
        add(s.unmatchedReceipts, row.amount, receiptKey);
        if (row.unmatchedReason === "no_csv_coverage") {
          add(s.unmatchedNoCoverage, row.amount, receiptKey);
        }
        if (row.unmatchedReason === "no_candidate") {
          add(s.unmatchedNoCandidate, row.amount, receiptKey);
        }
      }
      if (status === "cash") {
        add(row.cashSource === "auto" ? s.cashAuto : s.cashConfirmed, row.amount, receiptKey);
      }
    }

    if (!countsTowardTotals(row)) continue;
    s.total += row.amount;
    if (status === "unknown") s.adjustment += row.amount;
    else if (status === "cash") s.cash += row.amount;
    else if (isCard || status === "matched" || status === "fallback_split") s.card += row.amount;
    else s.provisional += row.amount;
  }
  return s;
}
