import { parseReceiptItemsMemo } from "@/lib/receipt-aggregation";
import { compareStoreNames, type StoreSimilarityOptions } from "@/lib/store-name";

/** 日付差がこの日数を超える突合は要確認にする */
export const DEFAULT_REVIEW_DAYS = 14;
/** 取込済みカードCSVの最新利用日からこの日数以内のレシートは現金に倒さない */
export const DEFAULT_CASH_MARGIN_DAYS = 3;

export type ReconcileStatus =
  | "unmatched"
  | "matched"
  | "fallback_split"
  | "cash"
  | "unknown";
export type PaymentMethod = "credit_card" | "cash" | "unknown";
export type CashSource = "confirmed" | "auto";
export type LedgerSource = "CSV" | "MANUAL" | "IMAGE";

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

/** 文字列の類似度だけで判定する既定の店名判定 */
export function textStoreJudge(options: StoreSimilarityOptions = {}): StoreJudge {
  return (cardName, receiptName) =>
    compareStoreNames(cardName, receiptName, options).similar ? "same" : "different";
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
 * 成立条件は「金額の完全一致」と「同じ店の判定」のみ。日付で候補は除外しない。
 * 候補の優先順: レシート日付<=カード日付 → 日付差の小さい順 → 店名類似度の高い順 → ID 昇順。
 */
export function matchCardAndReceipts(
  cards: CardTransaction[],
  receipts: Receipt[],
  options: MatchOptions = {}
): MatchResult {
  const judge = options.judgeStore ?? textStoreJudge(options.similarity);
  const reviewDays = options.reviewDays ?? DEFAULT_REVIEW_DAYS;

  type Candidate = ReconcileMatch & { receiptAfterRank: number; absDiff: number };
  const candidates: Candidate[] = [];
  const unresolvedPairs: UnresolvedStorePair[] = [];

  const openCards = cards.filter(isMatchableCard);
  const openReceipts = receipts.filter(isMatchableReceipt);

  for (const card of openCards) {
    for (const receipt of openReceipts) {
      if (card.amount !== receipt.amount) continue;
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

  const byCard = new Map(matches.map((m) => [m.cardId, m]));
  const byReceipt = new Map(matches.map((m) => [m.receiptId, m]));

  return {
    cards: cards.map((card) => {
      const m = byCard.get(card.id);
      return m
        ? { ...card, status: "matched", receiptId: m.receiptId, needsReview: m.needsReview }
        : card;
    }),
    receipts: receipts.map((receipt) => {
      const m = byReceipt.get(receipt.id);
      return m
        ? {
            ...receipt,
            status: "matched",
            cardTransactionId: m.cardId,
            needsReview: m.needsReview,
          }
        : receipt;
    }),
    matches,
    unresolvedPairs: unresolvedPairs.filter(
      (p) => !usedCards.has(p.cardId) && !usedReceipts.has(p.receiptId)
    ),
  };
}

export interface CardCoverage {
  /** 取込済みカードCSVの最古・最新の利用日（YYYY-MM-DD） */
  from: string;
  to: string;
}

export function cardCoverage(cardDates: string[]): CardCoverage | null {
  if (cardDates.length === 0) return null;
  const sorted = [...cardDates].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

/**
 * 突合後も未突合のレシートを現金（auto）に倒す（純関数）。
 * 対象はカードCSVの期間内（最古利用日〜最新利用日−marginDays）のレシートだけ。
 * 金額が一致するカード明細があり店名が未判定・判定不可のレシート（unresolvedPairs）は、
 * カード決済の可能性が高いため現金にしない。
 */
export function finalizeUnmatchedReceiptsAsCash(
  receipts: Receipt[],
  coverage: CardCoverage | null,
  options: { marginDays?: number; unresolvedPairs?: Pick<UnresolvedStorePair, "receiptId">[] } = {}
): { receipts: Receipt[]; finalizedIds: string[] } {
  if (!coverage) return { receipts, finalizedIds: [] };
  const margin = options.marginDays ?? DEFAULT_CASH_MARGIN_DAYS;
  const latestAllowed = addDays(coverage.to, -margin);
  const awaitingJudgement = new Set((options.unresolvedPairs ?? []).map((p) => p.receiptId));

  const finalizedIds: string[] = [];
  const next = receipts.map((receipt) => {
    const target =
      receipt.status === "unmatched" &&
      receipt.paymentMethod !== "cash" &&
      !receipt.autoCashExempt &&
      !awaitingJudgement.has(receipt.id) &&
      receipt.date >= coverage.from &&
      receipt.date <= latestAllowed;
    if (!target) return receipt;
    finalizedIds.push(receipt.id);
    return {
      ...receipt,
      paymentMethod: "cash" as const,
      status: "cash" as const,
      cashSource: "auto" as const,
    };
  });
  return { receipts: next, finalizedIds };
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
}

export function isActiveRow(row: Pick<LedgerRow, "archived" | "deletedAt" | "confirmed">) {
  return !row.archived && !row.deletedAt && row.confirmed !== false;
}

/**
 * 集計に含めるか。突合済みのカード明細はレシート側（内訳）で数えるため除外する。
 * 現金・未照合のカード明細・未突合のレシート・Unknown はそのまま数える。
 */
export function countsTowardTotals(
  row: Pick<LedgerRow, "archived" | "deletedAt" | "confirmed" | "source" | "reconcileStatus">
): boolean {
  if (!isActiveRow(row)) return false;
  return !(row.source === "CSV" && row.reconcileStatus === "matched");
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

/** 突合・現金判定の結果を行データに反映した新しい配列を返す（DB には書かない） */
export function applyReconcileToRows(
  rows: LedgerRow[],
  units: ReceiptUnit[],
  matches: ReconcileMatch[],
  finalizedCashUnitIds: string[] = []
): LedgerRow[] {
  const unitById = new Map(units.map((u) => [u.id, u]));
  const updates = new Map<string, Partial<LedgerRow>>();
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
      });
    }
  }
  for (const unitId of finalizedCashUnitIds) {
    for (const id of unitById.get(unitId)?.rowIds ?? []) {
      updates.set(id, { reconcileStatus: "cash", paymentMethod: "cash", cashSource: "auto" });
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
  unmatchedCards: AmountCount;
  unmatchedReceipts: AmountCount;
  cashConfirmed: AmountCount;
  cashAuto: AmountCount;
}

function add(acc: AmountCount, amount: number) {
  acc.amount += amount;
  acc.count += 1;
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
    unmatchedCards: zero(),
    unmatchedReceipts: zero(),
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
      if (status === "unmatched") add(s.unmatchedCards, row.amount);
    } else {
      if (status === "unmatched") add(s.unmatchedReceipts, row.amount);
      if (status === "cash") {
        add(row.cashSource === "auto" ? s.cashAuto : s.cashConfirmed, row.amount);
      }
    }

    if (!countsTowardTotals(row)) continue;
    s.total += row.amount;
    if (status === "unknown") s.adjustment += row.amount;
    else if (status === "cash") s.cash += row.amount;
    else if (isCard || status === "matched") s.card += row.amount;
    else s.provisional += row.amount;
  }
  return s;
}
