/**
 * 照合画面の手動操作（紐付け・現金確定・レシートなし確定・分割・重複除外・取り消し）の判定（純関数）。
 * 各操作は「どの行のどの値を、何から何に変えるか」と「追加する行」の計画（OperationPlan）を返し、
 * DB への反映と履歴の保存は manual-reconcile-service.ts が行う。
 * カード明細の金額を正とし、紐付け・分割の後は「内訳の合計 = カード明細の金額」を必ず満たす。
 */
import {
  DEFAULT_MAX_DAYS,
  diffDays,
  isActiveRow,
  storeNameOf,
  type CashSource,
  type LedgerRow,
  type PaymentMethod,
  type ReconcileStatus,
  type StoreJudge,
  type UnmatchedReason,
} from "@/lib/reconcile";
import { compareStoreNames, normalizeStoreName } from "@/lib/store-name";

/** 操作の前後で保存・比較する列（取り消しはこの値を元に戻す） */
export interface RowSnapshot {
  reconcileStatus: ReconcileStatus;
  paymentMethod: PaymentMethod | null;
  cashSource: CashSource | null;
  matchedCardId: string | null;
  matchedReceiptId: string | null;
  needsReview: boolean;
  unmatchedReason: UnmatchedReason | null;
  receiptGroupId: string | null;
  linkId: string | null;
  excludedReason: string | null;
  autoCashExempt: boolean;
  rejectedCardIds: string[];
  categoryId: string | null;
}

export interface RowChange {
  id: string;
  before: RowSnapshot;
  after: RowSnapshot;
}

/** 操作で追加する行（消費税・調整の行、レシートなし確定の内訳行） */
export interface NewRow extends RowSnapshot {
  id: string;
  date: string;
  description: string;
  amount: number;
  source: "MANUAL";
  memo: string;
}

export type OperationKind =
  | "link"
  | "cash"
  | "duplicate"
  | "card_only"
  | "unlink"
  | "unknown"
  | "undo";

export interface OperationPlan {
  kind: OperationKind;
  summary: string;
  changes: RowChange[];
  creates: NewRow[];
}

export type DiffMode = "tax" | "other";

/** conflict: 画面を開いた後に状態が変わった（再読み込みが必要）、invalid: 入力が不正 */
export class OperationError extends Error {
  constructor(
    readonly code: "conflict" | "invalid",
    message: string
  ) {
    super(message);
    this.name = "OperationError";
  }
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

export function snapshotOf(row: LedgerRow): RowSnapshot {
  return {
    reconcileStatus: row.reconcileStatus,
    paymentMethod: row.paymentMethod ?? null,
    cashSource: row.cashSource ?? null,
    matchedCardId: row.matchedCardId ?? null,
    matchedReceiptId: row.matchedReceiptId ?? null,
    needsReview: row.needsReview,
    unmatchedReason: row.unmatchedReason ?? null,
    receiptGroupId: row.receiptGroupId ?? null,
    linkId: row.linkId ?? null,
    excludedReason: row.excludedReason ?? null,
    autoCashExempt: row.autoCashExempt,
    rejectedCardIds: [...(row.rejectedCardIds ?? [])],
    categoryId: row.categoryId ?? null,
  };
}

const SNAPSHOT_KEYS: (keyof RowSnapshot)[] = [
  "reconcileStatus",
  "paymentMethod",
  "cashSource",
  "matchedCardId",
  "matchedReceiptId",
  "needsReview",
  "unmatchedReason",
  "receiptGroupId",
  "linkId",
  "excludedReason",
  "autoCashExempt",
  "rejectedCardIds",
  "categoryId",
];

/** 保存した履歴（jsonb はキーの順序を保たない）とも比べられるよう、列ごとに比べる */
export function sameSnapshot(a: RowSnapshot, b: RowSnapshot): boolean {
  return SNAPSHOT_KEYS.every((k) =>
    k === "rejectedCardIds"
      ? JSON.stringify([...(a[k] ?? [])].sort()) === JSON.stringify([...(b[k] ?? [])].sort())
      : (a[k] ?? null) === (b[k] ?? null)
  );
}

function change(row: LedgerRow, patch: Partial<RowSnapshot>): RowChange {
  const before = snapshotOf(row);
  return { id: row.id, before, after: { ...before, ...patch } };
}

/** レシート1枚の単位ID（品目分割は receiptGroupId、単独行は行ID） */
export function unitIdOf(rows: Pick<LedgerRow, "id" | "receiptGroupId">[]): string {
  return rows[0].receiptGroupId ?? rows[0].id;
}

export function isOpenCard(row: LedgerRow): boolean {
  return row.source === "CSV" && isActiveRow(row) && row.reconcileStatus === "unmatched" && row.amount > 0;
}

/** 手動で決着をつけられるレシート（未突合、または自動で現金にしたもの） */
export function isOpenReceiptRow(row: LedgerRow): boolean {
  return (
    row.source !== "CSV" &&
    isActiveRow(row) &&
    (row.reconcileStatus === "unmatched" ||
      (row.reconcileStatus === "cash" && row.cashSource === "auto"))
  );
}

function assertUnit(rows: LedgerRow[], label: string) {
  if (rows.length === 0) throw new OperationError("invalid", `${label}が指定されていません`);
  if (!rows.every(isOpenReceiptRow)) {
    throw new OperationError(
      "conflict",
      `${label}「${storeNameOf(rows[0].description)}」は、すでに処理済みです。再読み込みしてください`
    );
  }
  const status = rows[0].reconcileStatus;
  if (!rows.every((r) => r.reconcileStatus === status)) {
    throw new OperationError("conflict", `${label}の品目の状態がそろっていません。再読み込みしてください`);
  }
}

function assertCards(cards: LedgerRow[]) {
  if (cards.length === 0) throw new OperationError("invalid", "カード明細が指定されていません");
  if (new Set(cards.map((c) => c.id)).size !== cards.length) {
    throw new OperationError("invalid", "同じカード明細が重複して指定されています");
  }
  for (const c of cards) {
    if (!isOpenCard(c)) {
      throw new OperationError(
        "conflict",
        `カード明細「${c.description}」は、すでに処理済みです。再読み込みしてください`
      );
    }
  }
}

const sum = (rows: { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

/**
 * レシートとカード明細を紐付ける。1枚のレシートと複数のカード明細、または複数のレシートと1件のカード明細。
 * 合計が違う場合は diffMode が必須で、差額（カード − レシート）の行を最も金額の大きいレシートに加える。
 */
export function planLink(input: {
  cards: LedgerRow[];
  receipts: LedgerRow[][];
  diffMode?: DiffMode | null;
  opId: string;
  newId: () => string;
}): OperationPlan {
  const { cards, receipts, opId } = input;
  assertCards(cards);
  if (receipts.length === 0) throw new OperationError("invalid", "レシートが指定されていません");
  receipts.forEach((u) => assertUnit(u, "レシート"));
  const unitIds = receipts.map(unitIdOf);
  if (new Set(unitIds).size !== unitIds.length) {
    throw new OperationError("invalid", "同じレシートが重複して指定されています");
  }
  if (cards.length > 1 && receipts.length > 1) {
    throw new OperationError(
      "invalid",
      "複数のレシートと複数のカード明細を同時には紐付けられません（どちらかを1件にしてください）"
    );
  }

  const cardTotal = sum(cards);
  const receiptTotal = receipts.reduce((s, u) => s + sum(u), 0);
  const diff = cardTotal - receiptTotal;
  if (diff !== 0 && !input.diffMode) {
    throw new OperationError(
      "invalid",
      `金額が${yen(Math.abs(diff))}違います。差額の扱い（消費税・その他の調整）を選んでください`
    );
  }
  if (diff < 0 && input.diffMode === "tax") {
    throw new OperationError(
      "invalid",
      "レシートの方がカード明細より高いため、消費税としては加えられません。「その他の調整」を選んでください"
    );
  }

  const linkId = `link-${opId}`;
  const sortedCards = [...cards].sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id));
  const primaryCard = sortedCards[0];
  const target = [...receipts].sort((a, b) => sum(b) - sum(a) || unitIdOf(a).localeCompare(unitIdOf(b)))[0];
  const needsGroup = diff !== 0 && target.length === 1 && !target[0].receiptGroupId;
  const targetGroupId = needsGroup ? `manual-${opId}` : target[0].receiptGroupId;
  const targetUnitId = targetGroupId ?? target[0].id;

  const changes: RowChange[] = [];
  for (const card of sortedCards) {
    changes.push(
      change(card, {
        reconcileStatus: "matched",
        matchedReceiptId: targetUnitId,
        needsReview: false,
        linkId,
      })
    );
  }
  for (const unit of receipts) {
    for (const row of unit) {
      changes.push(
        change(row, {
          reconcileStatus: "matched",
          matchedCardId: primaryCard.id,
          paymentMethod: "credit_card",
          cashSource: null,
          unmatchedReason: null,
          needsReview: false,
          linkId,
          ...(unit === target && needsGroup ? { receiptGroupId: targetGroupId } : {}),
        })
      );
    }
  }

  const creates: NewRow[] = [];
  if (diff !== 0) {
    const label = input.diffMode === "tax" ? "消費税" : "調整";
    const largest = [...target].sort((a, b) => b.amount - a.amount)[0];
    creates.push({
      id: input.newId(),
      date: target[0].date,
      description: `${storeNameOf(target[0].description)} / ${label}`,
      amount: diff,
      source: "MANUAL",
      memo: `照合画面で追加（カード明細 ${yen(cardTotal)} とレシート ${yen(receiptTotal)} の差額）`,
      reconcileStatus: "matched",
      paymentMethod: "credit_card",
      cashSource: null,
      matchedCardId: primaryCard.id,
      matchedReceiptId: null,
      needsReview: false,
      unmatchedReason: null,
      receiptGroupId: targetGroupId,
      linkId,
      excludedReason: null,
      autoCashExempt: false,
      rejectedCardIds: [],
      categoryId: largest.categoryId ?? null,
    });
  }

  if (receiptTotal + sum(creates) !== cardTotal) {
    throw new Error("内訳の合計がカード明細の金額と一致しません");
  }

  const store = storeNameOf(target[0].description);
  const diffNote =
    diff === 0 ? "" : `、差額 ${yen(diff)} を${input.diffMode === "tax" ? "消費税" : "調整"}として追加`;
  return {
    kind: "link",
    summary:
      receipts.length > 1
        ? `レシート${receipts.length}枚（${yen(receiptTotal)}）をカード明細「${primaryCard.description}」${yen(cardTotal)} に紐付け${diffNote}`
        : `レシート「${store}」${yen(receiptTotal)} をカード明細${cards.length > 1 ? `${cards.length}件` : `「${primaryCard.description}」`}（${yen(cardTotal)}）に紐付け${diffNote}`,
    changes,
    creates,
  };
}

/** レシートを現金で確定する（自動で現金にしたものの確定も含む） */
export function planCash(unit: LedgerRow[]): OperationPlan {
  assertUnit(unit, "レシート");
  return {
    kind: "cash",
    summary: `レシート「${storeNameOf(unit[0].description)}」${yen(sum(unit))} を現金で確定`,
    changes: unit.map((row) =>
      change(row, {
        paymentMethod: "cash",
        reconcileStatus: "cash",
        cashSource: "confirmed",
        unmatchedReason: null,
        needsReview: false,
      })
    ),
    creates: [],
  };
}

/** 同じレシートの二重登録として除外する（行は残し、excludedReason に相手のレシートを記録する） */
export function planDuplicate(unit: LedgerRow[], partner: LedgerRow[], note?: string | null): OperationPlan {
  assertUnit(unit, "レシート");
  if (partner.length === 0) throw new OperationError("invalid", "重複の相手のレシートを選んでください");
  const partnerId = unitIdOf(partner);
  if (partnerId === unitIdOf(unit) || partner.some((p) => unit.some((u) => u.id === p.id))) {
    throw new OperationError("invalid", "同じレシートを重複の相手には選べません");
  }
  if (!partner.every((p) => p.source !== "CSV" && isActiveRow(p))) {
    throw new OperationError("conflict", "重複の相手のレシートが見つかりません。再読み込みしてください");
  }
  const reason = `manual_duplicate:${partnerId}`;
  return {
    kind: "duplicate",
    summary: `レシート「${storeNameOf(unit[0].description)}」${yen(sum(unit))} を、${partner[0].date} の「${storeNameOf(partner[0].description)}」${yen(sum(partner))} の重複として除外${note ? `（${note}）` : ""}`,
    changes: unit.map((row) => change(row, { excludedReason: reason, needsReview: false })),
    creates: [],
  };
}

/** 返金・調整など判断できない明細として Unknown にする（未照合のカード明細・レシート） */
export function planUnknown(rows: LedgerRow[]): OperationPlan {
  if (rows.length === 0) throw new OperationError("invalid", "明細が指定されていません");
  const isCard = rows[0].source === "CSV";
  if (isCard ? !rows.every(isOpenCard) : !rows.every(isOpenReceiptRow)) {
    throw new OperationError("conflict", "すでに処理済みです。再読み込みしてください");
  }
  return {
    kind: "unknown",
    summary: `「${storeNameOf(rows[0].description)}」${yen(sum(rows))} を Unknown（返金・調整など）に変更`,
    changes: rows.map((row) =>
      change(row, { reconcileStatus: "unknown", needsReview: false, unmatchedReason: null })
    ),
    creates: [],
  };
}

export interface SplitPart {
  categoryId: string;
  amount: number;
  categoryName?: string;
}

/**
 * レシートの無いカード明細をカテゴリ別の内訳で確定する（1カテゴリならレシートなし確定）。
 * カード明細は fallback_split にして集計から外し、内訳行（合計 = カード明細の金額）で数える。
 */
export function planCardOnly(input: {
  card: LedgerRow;
  parts: SplitPart[];
  opId: string;
  newId: () => string;
  viaRule?: boolean;
}): OperationPlan {
  const { card, parts } = input;
  assertCards([card]);
  if (parts.length === 0) throw new OperationError("invalid", "カテゴリを選んでください");
  for (const p of parts) {
    if (!p.categoryId) throw new OperationError("invalid", "カテゴリが選ばれていない内訳があります");
    if (!Number.isInteger(p.amount) || p.amount <= 0) {
      throw new OperationError("invalid", "内訳の金額は1円以上の整数で入力してください");
    }
  }
  const total = sum(parts);
  if (total !== card.amount) {
    throw new OperationError(
      "invalid",
      `内訳の合計 ${yen(total)} がカード明細の金額 ${yen(card.amount)} と一致しません（差 ${yen(card.amount - total)}）`
    );
  }

  const groupId = `split-${input.opId}`;
  const single = parts.length === 1;
  const creates: NewRow[] = parts.map((p, i) => ({
    id: input.newId(),
    date: card.date,
    description: card.description,
    amount: p.amount,
    source: "MANUAL",
    memo: single
      ? input.viaRule
        ? "レシートなしで自動確定（ルール）"
        : "レシートなしで確定"
      : `カード明細 ${yen(card.amount)} を分割（${i + 1}/${parts.length}）`,
    reconcileStatus: "fallback_split",
    paymentMethod: "credit_card",
    cashSource: null,
    matchedCardId: card.id,
    matchedReceiptId: null,
    needsReview: false,
    unmatchedReason: null,
    receiptGroupId: groupId,
    linkId: null,
    excludedReason: null,
    autoCashExempt: false,
    rejectedCardIds: [],
    categoryId: p.categoryId,
  }));
  const names = parts.map((p) => `${p.categoryName ?? "カテゴリ"} ${yen(p.amount)}`).join("、");
  return {
    kind: "card_only",
    summary: single
      ? `カード明細「${card.description}」${yen(card.amount)} をレシートなしで確定（${parts[0].categoryName ?? "カテゴリ"}）${input.viaRule ? "［ルール］" : ""}`
      : `カード明細「${card.description}」${yen(card.amount)} を${parts.length}つのカテゴリに分割（${names}）`,
    changes: [
      change(card, {
        reconcileStatus: "fallback_split",
        matchedReceiptId: groupId,
        needsReview: false,
        ...(single ? { categoryId: parts[0].categoryId } : {}),
      }),
    ],
    creates,
  };
}

/**
 * 紐付けを解除する（自動突合した組の「解除」）。同じ組を自動で再突合しないよう rejectedCardIds に記録する。
 * linkRows には、組に属するカード明細とレシートの全行を渡す。
 */
export function planUnlink(linkRows: LedgerRow[]): OperationPlan {
  const cards = linkRows.filter((r) => r.source === "CSV");
  const receipts = linkRows.filter((r) => r.source !== "CSV");
  if (cards.length === 0 || !cards.every((c) => c.reconcileStatus === "matched")) {
    throw new OperationError("conflict", "この照合はすでに解除されています。再読み込みしてください");
  }
  const cardIds = cards.map((c) => c.id);
  return {
    kind: "unlink",
    summary: `カード明細「${cards[0].description}」${yen(sum(cards))} の照合を解除`,
    changes: [
      ...cards.map((c) =>
        change(c, { reconcileStatus: "unmatched", matchedReceiptId: null, needsReview: false, linkId: null })
      ),
      ...receipts
        .filter((r) => r.reconcileStatus === "matched")
        .map((r) =>
          change(r, {
            reconcileStatus: "unmatched",
            matchedCardId: null,
            needsReview: false,
            linkId: null,
            rejectedCardIds: [...new Set([...(r.rejectedCardIds ?? []), ...cardIds])],
          })
        ),
    ],
    creates: [],
  };
}

/**
 * 操作を取り消す。各行の現在の値が操作後の値のままのときだけ、操作前の値に戻す。
 * 操作で追加した行は削除せず、excludedReason に `undone:<操作ID>` を入れて集計から外す。
 */
export function planUndo(
  op: { id: string; summary: string; changes: RowChange[]; createdRowIds: string[] },
  current: LedgerRow[]
): OperationPlan {
  const byId = new Map(current.map((r) => [r.id, r]));
  const changes: RowChange[] = [];
  for (const c of op.changes) {
    const row = byId.get(c.id);
    if (!row || !sameSnapshot(snapshotOf(row), c.after)) {
      throw new OperationError(
        "conflict",
        "この操作の後に、同じ明細が別の操作で変更されています。後の操作から順に取り消してください"
      );
    }
    changes.push({ id: c.id, before: c.after, after: c.before });
  }
  for (const id of op.createdRowIds) {
    const row = byId.get(id);
    if (!row || row.excludedReason) {
      throw new OperationError("conflict", "この操作で追加した行が変更されています。再読み込みしてください");
    }
    changes.push(change(row, { excludedReason: `undone:${op.id}` }));
  }
  return { kind: "undo", summary: `取り消し: ${op.summary}`, changes, creates: [] };
}

/** 計画を行データに反映した新しい配列（DB には書かない。テストと整合性の確認用） */
export function applyPlan(rows: LedgerRow[], plan: OperationPlan): LedgerRow[] {
  const byId = new Map(plan.changes.map((c) => [c.id, c.after]));
  const next = rows.map((r) => (byId.has(r.id) ? { ...r, ...byId.get(r.id)! } : r));
  for (const n of plan.creates) {
    next.push({ ...n, confirmed: true, archived: false, deletedAt: null, importBatchId: null });
  }
  return next;
}

/** 紐付け・分割の内訳の合計がカード明細の金額と一致しない組（整合性の確認用。空なら正常） */
export function findBreakdownMismatches(rows: LedgerRow[]): { cardIds: string[]; cardTotal: number; breakdownTotal: number }[] {
  const active = rows.filter(isActiveRow);
  const cards = active.filter(
    (r) => r.source === "CSV" && (r.reconcileStatus === "matched" || r.reconcileStatus === "fallback_split")
  );
  const groups = new Map<string, LedgerRow[]>();
  for (const c of cards) {
    const key = c.linkId ?? c.id;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: { cardIds: string[]; cardTotal: number; breakdownTotal: number }[] = [];
  for (const [key, groupCards] of groups) {
    const ids = new Set(groupCards.map((c) => c.id));
    const breakdown = active.filter(
      (r) =>
        r.source !== "CSV" &&
        (r.reconcileStatus === "matched" || r.reconcileStatus === "fallback_split") &&
        ((r.linkId && r.linkId === key) || (r.matchedCardId && ids.has(r.matchedCardId)))
    );
    const cardTotal = sum(groupCards);
    const breakdownTotal = sum(breakdown);
    if (cardTotal !== breakdownTotal) out.push({ cardIds: [...ids], cardTotal, breakdownTotal });
  }
  return out;
}

export interface CandidateSource {
  id: string;
  date: string;
  storeName: string;
  amount: number;
}

export interface RankedCandidate extends CandidateSource {
  /** カード明細 − レシート（紐付けたときに加える差額） */
  adjust: number;
  /** 候補の日付 − 対象の日付（日） */
  dateDiffDays: number;
  storeScore: number;
  sameStore: boolean;
  exact: boolean;
  score: number;
}

/** 店名が似ていない組で、金額の近さ（10%以内）だけで候補に出す日付差の上限 */
const NEAR_AMOUNT_MAX_DAYS = 3;

/**
 * 紐付けの候補を近い順に並べる。side は対象（target）の種類。
 * 店名の判定・日付の近さ・金額の近さを合わせた点数の高い順。金額の完全一致は加点する。
 * 同じ店と判定した組は金額が離れていても残す（ETC のように複数の明細を合わせる場合があるため）。
 * 店名が似ていない組は、金額が完全一致するか、金額が10%以内かつ日付差3日以内のときだけ出す。
 */
export function rankCandidates(
  side: "receipt" | "card",
  target: CandidateSource,
  pool: CandidateSource[],
  judge: StoreJudge,
  options: { maxDays?: number; limit?: number } = {}
): RankedCandidate[] {
  const maxDays = options.maxDays ?? DEFAULT_MAX_DAYS;
  const limit = options.limit ?? 8;
  const out: RankedCandidate[] = [];
  for (const c of pool) {
    if (c.id === target.id || c.amount <= 0) continue;
    const dateDiffDays = diffDays(target.date, c.date);
    if (Math.abs(dateDiffDays) > maxDays) continue;
    const [card, receipt] = side === "receipt" ? [c, target] : [target, c];
    const verdict = judge(card.storeName, receipt.storeName);
    const storeScore =
      verdict === "same"
        ? 1
        : verdict === "different"
          ? 0
          : compareStoreNames(card.storeName, receipt.storeName).score;
    const adjust = card.amount - receipt.amount;
    const exact = adjust === 0;
    const near =
      Math.abs(adjust) <= Math.max(card.amount, receipt.amount) * 0.1 &&
      Math.abs(dateDiffDays) <= NEAR_AMOUNT_MAX_DAYS;
    if (!exact && !near && storeScore < 0.5) continue;
    const amountScore = exact ? 1 : Math.max(0, 1 - Math.abs(adjust) / Math.max(card.amount, receipt.amount, 1));
    const dateScore = Math.max(0, 1 - Math.abs(dateDiffDays) / maxDays);
    out.push({
      ...c,
      adjust,
      dateDiffDays,
      storeScore,
      sameStore: verdict === "same",
      exact,
      score: 0.45 * storeScore + 0.35 * amountScore + 0.2 * dateScore + (exact ? 0.1 : 0),
    });
  }
  return out
    .sort(
      (a, b) =>
        b.score - a.score ||
        Math.abs(a.dateDiffDays) - Math.abs(b.dateDiffDays) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, limit);
}

/**
 * 「候補1番を一括採用」の対象。候補1番の金額が完全一致する行だけを選び、
 * 同じ明細が複数の組に関わる場合（同じ候補が複数の行の1番、レシートとカードの両方を選んで同じ組になる等）は、
 * 先の組だけを採用する（後の行は手動で選ぶ）。
 */
export function pickBulkTopExact<T extends { id: string; candidates: RankedCandidate[] }>(
  items: T[]
): { targets: { item: T; candidateId: string }[]; skipped: { item: T; reason: string }[] } {
  const used = new Set<string>();
  const targets: { item: T; candidateId: string }[] = [];
  const skipped: { item: T; reason: string }[] = [];
  for (const item of items) {
    const top = item.candidates[0];
    if (!top) {
      skipped.push({ item, reason: "候補なし" });
    } else if (!top.exact) {
      skipped.push({ item, reason: "候補1番の金額が一致しない" });
    } else if (used.has(top.id) || used.has(item.id)) {
      skipped.push({ item, reason: "候補1番が他の行と重なる" });
    } else {
      used.add(top.id);
      used.add(item.id);
      targets.push({ item, candidateId: top.id });
    }
  }
  return { targets, skipped };
}

/** 重複登録の相手の候補（日付差7日以内・金額が同じレシート。同じ日・同じ店ほど上） */
export function rankDuplicateCandidates(
  target: CandidateSource,
  pool: CandidateSource[],
  limit = 5
): (CandidateSource & { dateDiffDays: number; storeScore: number })[] {
  return pool
    .filter((c) => c.id !== target.id && c.amount === target.amount)
    .map((c) => ({
      ...c,
      dateDiffDays: diffDays(target.date, c.date),
      storeScore: compareStoreNames(target.storeName, c.storeName).score,
    }))
    .filter((c) => Math.abs(c.dateDiffDays) <= 7)
    .sort(
      (a, b) =>
        Math.abs(a.dateDiffDays) - Math.abs(b.dateDiffDays) ||
        b.storeScore - a.storeScore ||
        a.id.localeCompare(b.id)
    )
    .slice(0, limit);
}

export interface CardOnlyRuleLike {
  id: string;
  storeKey: string;
  categoryId: string;
  enabled: boolean;
  deletedAt?: Date | string | null;
}

export function cardOnlyRuleKey(storeName: string): string {
  return normalizeStoreName(storeName);
}

/** カード明細の店名（正規化後）に一致する、有効なレシートなし自動確定のルール */
export function findCardOnlyRule<T extends CardOnlyRuleLike>(storeName: string, rules: T[]): T | null {
  const key = cardOnlyRuleKey(storeName);
  if (!key) return null;
  return rules.find((r) => r.enabled && !r.deletedAt && r.storeKey === key) ?? null;
}
