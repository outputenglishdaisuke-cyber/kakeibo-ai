import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlan,
  findBreakdownMismatches,
  findCardOnlyRule,
  OperationError,
  pickBulkTopExact,
  planCardOnly,
  planCash,
  planDuplicate,
  planLink,
  planUndo,
  planUnknown,
  planUnlink,
  rankCandidates,
  rankDuplicateCandidates,
  snapshotOf,
  type OperationPlan,
  type RowChange,
} from "./manual-reconcile";
import {
  applyReconcileToRows,
  buildReceiptUnits,
  buildReconcileSummary,
  countsTowardTotals,
  finalizeUnmatchedReceiptsAsCash,
  matchCardAndReceipts,
  textStoreJudge,
  toCardTransaction,
  type LedgerRow,
} from "./reconcile";

function row(partial: Partial<LedgerRow> & Pick<LedgerRow, "id" | "amount">): LedgerRow {
  return {
    date: "2026-09-10",
    description: "店",
    source: "IMAGE",
    categoryId: "food",
    memo: null,
    confirmed: true,
    archived: false,
    deletedAt: null,
    paymentMethod: "unknown",
    reconcileStatus: "unmatched",
    cashSource: null,
    needsReview: false,
    receiptGroupId: null,
    matchedReceiptId: null,
    matchedCardId: null,
    autoCashExempt: false,
    rejectedCardIds: [],
    unmatchedReason: null,
    importBatchId: null,
    excludedReason: null,
    linkId: null,
    ...partial,
  };
}

const card = (id: string, amount: number, extra: Partial<LedgerRow> = {}) =>
  row({ id, amount, source: "CSV", paymentMethod: null, categoryId: "other", ...extra });

/** 集計（ダッシュボード・取引一覧・予算と同じ規則）で数える合計 */
const countedTotal = (rows: LedgerRow[]) =>
  rows.filter(countsTowardTotals).reduce((s, r) => s + r.amount, 0);

let seq = 0;
const newId = () => `new-${++seq}`;

function undoOf(plan: OperationPlan, rows: LedgerRow[], opId = "op1") {
  const createdRowIds = plan.creates.map((c) => c.id);
  return planUndo({ id: opId, summary: plan.summary, changes: plan.changes, createdRowIds }, rows);
}

/** 取り消し後は、操作前の行と状態・金額が完全に一致し、追加行は集計から外れている */
function assertRestored(before: LedgerRow[], after: LedgerRow[]) {
  const byId = new Map(after.map((r) => [r.id, r]));
  for (const r of before) {
    assert.deepEqual(snapshotOf(byId.get(r.id)!), snapshotOf(r), `row ${r.id}`);
    assert.equal(byId.get(r.id)!.amount, r.amount);
  }
  const added = after.filter((r) => !before.some((b) => b.id === r.id));
  assert.ok(added.every((r) => r.excludedReason?.startsWith("undone:")));
  assert.equal(countedTotal(after), countedTotal(before));
  assert.deepEqual(buildReconcileSummary(after), buildReconcileSummary(before));
}

describe("planLink（レシートとカード明細の紐付け）", () => {
  test("金額一致: 両方が matched になり、集計は二重に数えない", () => {
    const rows = [card("c1", 1000, { description: "イオン" }), row({ id: "r1", amount: 1000, description: "イオン / 食品" })];
    assert.equal(countedTotal(rows), 2000);
    const plan = planLink({ cards: [rows[0]], receipts: [[rows[1]]], opId: "op1", newId });
    const after = applyPlan(rows, plan);
    assert.equal(after.find((r) => r.id === "c1")!.reconcileStatus, "matched");
    assert.equal(after.find((r) => r.id === "c1")!.matchedReceiptId, "r1");
    assert.equal(after.find((r) => r.id === "r1")!.matchedCardId, "c1");
    assert.equal(after.find((r) => r.id === "r1")!.paymentMethod, "credit_card");
    assert.equal(countedTotal(after), 1000);
    const s = buildReconcileSummary(after);
    assert.equal(s.total, 1000);
    assert.equal(s.card, 1000);
    assert.equal(s.matched.count, 1);
    assert.equal(s.unmatchedCards.count, 0);
    assert.equal(s.unmatchedReceipts.count, 0);
    assert.deepEqual(findBreakdownMismatches(after), []);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });

  test("金額が違う: 差額の扱いが必須。消費税の行を加えると内訳の合計がカード明細と一致する", () => {
    const rows = [
      card("c1", 1080, { description: "ビッグ・エー" }),
      row({ id: "r1", amount: 1000, description: "Big-A / 食品", categoryId: "food" }),
    ];
    assert.throws(
      () => planLink({ cards: [rows[0]], receipts: [[rows[1]]], opId: "op1", newId }),
      (e: unknown) => e instanceof OperationError && e.code === "invalid"
    );
    const plan = planLink({ cards: [rows[0]], receipts: [[rows[1]]], diffMode: "tax", opId: "op1", newId });
    assert.equal(plan.creates.length, 1);
    assert.equal(plan.creates[0].amount, 80);
    assert.equal(plan.creates[0].description, "Big-A / 消費税");
    assert.equal(plan.creates[0].categoryId, "food");
    const after = applyPlan(rows, plan);
    const { units } = buildReceiptUnits(after);
    assert.equal(units.length, 1);
    assert.equal(units[0].amount, 1080);
    assert.deepEqual(findBreakdownMismatches(after), []);
    assert.equal(countedTotal(after), 1080);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });

  test("レシートの方が高い場合は消費税にできず、調整行（マイナス）で合わせる", () => {
    const rows = [card("c1", 950), row({ id: "r1", amount: 1000 })];
    assert.throws(() =>
      planLink({ cards: [rows[0]], receipts: [[rows[1]]], diffMode: "tax", opId: "op1", newId })
    );
    const plan = planLink({ cards: [rows[0]], receipts: [[rows[1]]], diffMode: "other", opId: "op1", newId });
    assert.equal(plan.creates[0].amount, -50);
    const after = applyPlan(rows, plan);
    assert.equal(countedTotal(after), 950);
    assert.deepEqual(findBreakdownMismatches(after), []);
  });

  test("ETC: 4件のカード明細の合計 = 1枚のレシートなら差額なしで紐付く", () => {
    const cards = [510, 1040, 1940, 2080].map((a, i) =>
      card(`etc${i}`, a, { date: "2026-08-24", description: "ETC" })
    );
    const receipt = row({ id: "r1", amount: 5570, date: "2026-09-01", description: "ETC", source: "MANUAL" });
    const rows = [...cards, receipt];
    assert.equal(countedTotal(rows), 11140);
    const plan = planLink({ cards, receipts: [[receipt]], opId: "op1", newId });
    assert.equal(plan.creates.length, 0);
    const after = applyPlan(rows, plan);
    assert.ok(after.filter((r) => r.source === "CSV").every((c) => c.reconcileStatus === "matched"));
    assert.equal(new Set(after.map((r) => r.linkId)).size, 1);
    assert.equal(countedTotal(after), 5570);
    assert.deepEqual(findBreakdownMismatches(after), []);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });

  test("ETC: 合計が合わない（4,570円のレシート）場合は差額の扱いが必須で、調整後は一致する", () => {
    const cards = [510, 1040, 1940, 2080].map((a, i) => card(`etc${i}`, a, { description: "ETC" }));
    const receipt = row({ id: "r1", amount: 4570, description: "ETC", source: "MANUAL" });
    assert.throws(
      () => planLink({ cards, receipts: [[receipt]], opId: "op1", newId }),
      /差額の扱い/
    );
    const plan = planLink({ cards, receipts: [[receipt]], diffMode: "other", opId: "op1", newId });
    assert.equal(plan.creates[0].amount, 1000);
    const after = applyPlan([...cards, receipt], plan);
    assert.equal(countedTotal(after), 5570);
    assert.deepEqual(findBreakdownMismatches(after), []);
  });

  test("複数のレシートと1件のカード明細", () => {
    const rows = [
      card("c1", 3000),
      row({ id: "r1", amount: 1000 }),
      row({ id: "g1", amount: 1500, receiptGroupId: "grp" }),
      row({ id: "g2", amount: 500, receiptGroupId: "grp" }),
    ];
    const plan = planLink({
      cards: [rows[0]],
      receipts: [[rows[1]], [rows[2], rows[3]]],
      opId: "op1",
      newId,
    });
    const after = applyPlan(rows, plan);
    assert.equal(countedTotal(after), 3000);
    assert.ok(after.filter((r) => r.source !== "CSV").every((r) => r.matchedCardId === "c1"));
    assert.deepEqual(findBreakdownMismatches(after), []);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });

  test("複数のレシートと複数のカード明細の同時指定は不可", () => {
    assert.throws(() =>
      planLink({
        cards: [card("c1", 1), card("c2", 1)],
        receipts: [[row({ id: "r1", amount: 1 })], [row({ id: "r2", amount: 1 })]],
        opId: "op1",
        newId,
      })
    );
  });

  test("自動で現金にしたレシートもカード明細に紐付けられ、現金から外れる", () => {
    const rows = [
      card("c1", 700),
      row({ id: "r1", amount: 700, reconcileStatus: "cash", paymentMethod: "cash", cashSource: "auto" }),
    ];
    const after = applyPlan(rows, planLink({ cards: [rows[0]], receipts: [[rows[1]]], opId: "op1", newId }));
    const r = after.find((x) => x.id === "r1")!;
    assert.equal(r.reconcileStatus, "matched");
    assert.equal(r.cashSource, null);
    assert.equal(countedTotal(after), 700);
    assert.equal(buildReconcileSummary(after).cash, 0);
  });
});

describe("planCash（現金で確定）", () => {
  test("現金確定で総支出は減らない（暫定 → 現金）", () => {
    const rows = [row({ id: "r1", amount: 1200 }), card("c1", 500)];
    const before = buildReconcileSummary(rows);
    const plan = planCash([rows[0]]);
    const after = applyPlan(rows, plan);
    const s = buildReconcileSummary(after);
    assert.equal(s.total, before.total);
    assert.equal(s.cash, 1200);
    assert.equal(s.provisional, 0);
    assert.equal(s.cashConfirmed.count, 1);
    const r = after.find((x) => x.id === "r1")!;
    assert.deepEqual([r.paymentMethod, r.reconcileStatus, r.cashSource], ["cash", "cash", "confirmed"]);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });

  test("自動現金（auto）を確定（confirmed）にしても総支出は変わらない", () => {
    const rows = [row({ id: "r1", amount: 800, reconcileStatus: "cash", paymentMethod: "cash", cashSource: "auto" })];
    const after = applyPlan(rows, planCash(rows));
    assert.equal(buildReconcileSummary(after).total, 800);
    assert.equal(after[0].cashSource, "confirmed");
  });
});

describe("planCardOnly（カードだけで確定・カテゴリ分割）", () => {
  test("レシートなし確定: 未照合から外れ、総支出は変わらず、カテゴリが付く", () => {
    const rows = [card("c1", 3000, { description: "東京電力", categoryId: null })];
    const plan = planCardOnly({
      card: rows[0],
      parts: [{ categoryId: "utility", amount: 3000, categoryName: "電気" }],
      opId: "op1",
      newId,
    });
    const after = applyPlan(rows, plan);
    assert.equal(after[0].reconcileStatus, "fallback_split");
    assert.equal(after[0].categoryId, "utility");
    const s = buildReconcileSummary(after);
    assert.equal(s.total, 3000);
    assert.equal(s.card, 3000);
    assert.equal(s.unmatchedCards.count, 0);
    assert.equal(s.cardOnly.count, 1);
    const counted = after.filter(countsTowardTotals);
    assert.equal(counted.length, 1);
    assert.equal(counted[0].categoryId, "utility");
    assert.deepEqual(findBreakdownMismatches(after), []);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });

  test("複数カテゴリへの分割: 合計が一致しなければ確定できない", () => {
    const c = card("c1", 10000);
    assert.throws(
      () =>
        planCardOnly({
          card: c,
          parts: [
            { categoryId: "food", amount: 6000 },
            { categoryId: "daily", amount: 3000 },
          ],
          opId: "op1",
          newId,
        }),
      /一致しません/
    );
    assert.throws(() =>
      planCardOnly({ card: c, parts: [{ categoryId: "food", amount: 0 }, { categoryId: "x", amount: 10000 }], opId: "op1", newId })
    );
    const plan = planCardOnly({
      card: c,
      parts: [
        { categoryId: "food", amount: 6000 },
        { categoryId: "daily", amount: 4000 },
      ],
      opId: "op1",
      newId,
    });
    const after = applyPlan([c], plan);
    const counted = after.filter(countsTowardTotals);
    assert.deepEqual(
      counted.map((r) => [r.categoryId, r.amount]),
      [
        ["food", 6000],
        ["daily", 4000],
      ]
    );
    assert.equal(countedTotal(after), 10000);
    assert.deepEqual(findBreakdownMismatches(after), []);
    assertRestored([c], applyPlan(after, undoOf(plan, after)));
  });
});

describe("planDuplicate / planUnknown / planUnlink", () => {
  test("重複として除外: 集計から外れ、相手のレシートが理由に残る。取り消しで戻る", () => {
    const rows = [row({ id: "r1", amount: 920 }), row({ id: "r2", amount: 920 })];
    const plan = planDuplicate([rows[1]], [rows[0]], "2回撮影");
    const after = applyPlan(rows, plan);
    assert.equal(after[1].excludedReason, "manual_duplicate:r1");
    assert.equal(countedTotal(after), 920);
    assert.match(plan.summary, /2回撮影/);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
    assert.throws(() => planDuplicate([rows[0]], [rows[0]]));
  });

  test("Unknown にして取り消す", () => {
    const rows = [card("c1", 400)];
    const plan = planUnknown(rows);
    const after = applyPlan(rows, plan);
    assert.equal(after[0].reconcileStatus, "unknown");
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });

  test("自動で照合した組の解除は、同じ組を再突合しないよう記録し、取り消しで照合に戻る", () => {
    const rows = [
      card("c1", 500, { reconcileStatus: "matched", matchedReceiptId: "r1" }),
      row({ id: "r1", amount: 500, reconcileStatus: "matched", matchedCardId: "c1" }),
    ];
    const plan = planUnlink(rows);
    const after = applyPlan(rows, plan);
    assert.equal(after[0].reconcileStatus, "unmatched");
    assert.deepEqual(after[1].rejectedCardIds, ["c1"]);
    assert.equal(countedTotal(after), 1000);
    assertRestored(rows, applyPlan(after, undoOf(plan, after)));
  });
});

describe("二重操作・取り消しの安全性", () => {
  test("処理済みの行への操作は conflict で失敗する（2つの画面から同じ操作をした場合）", () => {
    const rows = [card("c1", 1000), row({ id: "r1", amount: 1000 })];
    const after = applyPlan(rows, planLink({ cards: [rows[0]], receipts: [[rows[1]]], opId: "op1", newId }));
    const isConflict = (e: unknown) => e instanceof OperationError && e.code === "conflict";
    assert.throws(() => planLink({ cards: [after[0]], receipts: [[after[1]]], opId: "op2", newId }), isConflict);
    assert.throws(() => planCash([after[1]]), isConflict);
    assert.throws(
      () => planCardOnly({ card: after[0], parts: [{ categoryId: "x", amount: 1000 }], opId: "op3", newId }),
      isConflict
    );
  });

  test("同じ操作の二重取り消し・後の操作が残っている状態での取り消しは conflict", () => {
    const rows = [row({ id: "r1", amount: 1000 }), card("c1", 1000)];
    const cash = planCash([rows[0]]);
    const afterCash = applyPlan(rows, cash);
    const undo = undoOf(cash, afterCash);
    const restored = applyPlan(afterCash, undo);
    assert.throws(() => undoOf(cash, restored), (e: unknown) => e instanceof OperationError && e.code === "conflict");

    const link = planLink({ cards: [restored[1]], receipts: [[restored[0]]], opId: "op2", newId });
    const afterLink = applyPlan(restored, link);
    assert.throws(() => undoOf(cash, afterLink), /後の操作から順に/);
  });

  test("保存した履歴のキー順が変わっていても（jsonb）取り消せる", () => {
    const rows = [row({ id: "r1", amount: 1000 })];
    const plan = planCash(rows);
    const after = applyPlan(rows, plan);
    const reorder = (s: object) =>
      Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)));
    const stored = JSON.parse(
      JSON.stringify(plan.changes.map((c) => ({ id: c.id, before: reorder(c.before), after: reorder(c.after) })))
    ) as RowChange[];
    const undo = planUndo({ id: "op1", summary: plan.summary, changes: stored, createdRowIds: [] }, after);
    assertRestored(rows, applyPlan(after, undo));
  });

  test("取り消しで追加行は削除せず excludedReason で外す", () => {
    const rows = [card("c1", 1100), row({ id: "r1", amount: 1000 })];
    const plan = planLink({ cards: [rows[0]], receipts: [[rows[1]]], diffMode: "tax", opId: "op1", newId });
    const after = applyPlan(rows, plan);
    const undone = applyPlan(after, undoOf(plan, after));
    const added = undone.find((r) => r.id === plan.creates[0].id)!;
    assert.ok(added);
    assert.equal(added.excludedReason, "undone:op1");
    assert.equal(undone.find((r) => r.id === "r1")!.receiptGroupId, null);
  });
});

describe("自動突合との関係（冪等性）", () => {
  /** CSV取込時と同じ順に、突合 → 現金への自動判定を行う */
  function rerunAuto(rows: LedgerRow[]): LedgerRow[] {
    const cards = rows.filter((r) => r.source === "CSV").map(toCardTransaction);
    const { units } = buildReceiptUnits(rows);
    const result = matchCardAndReceipts(cards, units, { judgeStore: textStoreJudge() });
    const { finalizedIds } = finalizeUnmatchedReceiptsAsCash(result.receipts, [
      { segments: [{ from: "2026-08-01", to: "2026-09-30", count: 10 }] },
    ]);
    return applyReconcileToRows(rows, units, result.matches, finalizedIds, result.receipts);
  }

  test("手動で確定したもの（紐付け・現金・レシートなし）は自動突合の再実行で変わらない", () => {
    let rows: LedgerRow[] = [
      card("c1", 1080, { description: "セブンイレブン" }),
      row({ id: "r1", amount: 1000, description: "セブン-イレブン / 食品" }),
      card("c2", 3000, { description: "東京電力" }),
      row({ id: "r2", amount: 600, description: "八百屋" }),
    ];
    rows = applyPlan(rows, planLink({ cards: [rows[0]], receipts: [[rows[1]]], diffMode: "tax", opId: "a", newId }));
    rows = applyPlan(rows, planCardOnly({ card: rows[2], parts: [{ categoryId: "utility", amount: 3000 }], opId: "b", newId }));
    rows = applyPlan(rows, planCash([rows[3]]));
    // 後から、レシートなしで確定したカード明細と同額・同店のレシートが入った
    rows.push(row({ id: "late", amount: 3000, description: "東京電力", source: "MANUAL" }));

    const once = rerunAuto(rows);
    const twice = rerunAuto(once);
    for (const id of ["c1", "r1", "c2", "r2"]) {
      assert.deepEqual(snapshotOf(once.find((r) => r.id === id)!), snapshotOf(rows.find((r) => r.id === id)!), id);
    }
    assert.deepEqual(twice.map(snapshotOf), once.map(snapshotOf));
    assert.equal(once.find((r) => r.id === "late")!.reconcileStatus, "cash");
    assert.equal(once.find((r) => r.id === "c2")!.reconcileStatus, "fallback_split");
  });

  test("レシートなしで確定したカード明細に合うレシートは候補として出るが、自動では紐付かない", () => {
    const candidates = rankCandidates(
      "card",
      { id: "c2", date: "2026-09-10", storeName: "東京電力", amount: 3000 },
      [{ id: "late", date: "2026-09-10", storeName: "東京電力", amount: 3000 }],
      textStoreJudge()
    );
    assert.equal(candidates[0].exact && candidates[0].sameStore, true);
  });
});

describe("候補の並び・一括採用・ルール", () => {
  const judge = textStoreJudge();
  test("候補は店名・日付・金額が近い順。完全一致と差額のある候補の両方を出す", () => {
    const list = rankCandidates(
      "receipt",
      { id: "r1", date: "2026-09-10", storeName: "セブンイレブン 川口店", amount: 1000 },
      [
        { id: "far", date: "2026-09-30", storeName: "セブン-イレブン", amount: 1000 },
        { id: "tax", date: "2026-09-10", storeName: "セブン-イレブン", amount: 1080 },
        { id: "exact", date: "2026-09-11", storeName: "セブン-イレブン", amount: 1000 },
        { id: "other", date: "2026-09-10", storeName: "ニトリ", amount: 5000 },
        { id: "nearFar", date: "2026-09-25", storeName: "ニトリ", amount: 1050 },
        { id: "old", date: "2026-07-01", storeName: "セブン-イレブン", amount: 1000 },
      ],
      judge
    );
    // 同日で差額が税込換算ぶんの候補は、20日離れた金額一致の候補より近いとみなす
    assert.deepEqual(
      list.map((c) => c.id),
      ["exact", "tax", "far"]
    );
    assert.equal(list.find((c) => c.id === "tax")!.adjust, 80);
    assert.equal(list[0].exact, true);
  });

  test("一括の「候補1番を採用」は金額が完全一致する候補のみ。重なる候補は先の行だけ", () => {
    const c = (id: string, exact: boolean) => ({
      id,
      date: "2026-09-10",
      storeName: "x",
      amount: 1,
      adjust: exact ? 0 : 5,
      dateDiffDays: 0,
      storeScore: 1,
      sameStore: true,
      exact,
      score: 1,
    });
    const { targets, skipped } = pickBulkTopExact([
      { id: "r1", candidates: [c("c1", true)] },
      { id: "r2", candidates: [c("c2", false), c("c3", true)] },
      { id: "r3", candidates: [c("c1", true)] },
      { id: "r4", candidates: [] },
      { id: "c1", candidates: [c("r9", true)] },
    ]);
    assert.deepEqual(targets.map((t) => [t.item.id, t.candidateId]), [["r1", "c1"]]);
    assert.deepEqual(
      skipped.map((s) => s.item.id),
      ["r2", "r3", "r4", "c1"]
    );
  });

  test("重複の相手の候補は同じ金額・前後7日以内", () => {
    const list = rankDuplicateCandidates(
      { id: "r1", date: "2026-08-29", storeName: "Big-A", amount: 940 },
      [
        { id: "a", date: "2026-08-29", storeName: "Big-A 鳩ヶ谷", amount: 940 },
        { id: "b", date: "2026-09-20", storeName: "Big-A", amount: 940 },
        { id: "c", date: "2026-08-29", storeName: "Big-A", amount: 941 },
      ]
    );
    assert.deepEqual(list.map((x) => x.id), ["a"]);
  });

  test("レシートなし自動確定のルールは正規化後の店名で当たり、無効・削除済みは使わない", () => {
    const rules = [
      { id: "1", storeKey: "etc", categoryId: "car", enabled: false },
      { id: "2", storeKey: "etc", categoryId: "car", enabled: true, deletedAt: new Date() },
    ];
    assert.equal(findCardOnlyRule("ＥＴＣ", rules), null);
    const key = findCardOnlyRule("ETC", [{ id: "3", storeKey: "etc", categoryId: "car", enabled: true }]);
    assert.equal(key?.id, "3");
  });
});

describe("履歴（RowChange）", () => {
  test("各変更は元の値と新しい値を持つ", () => {
    const c = card("c1", 100);
    const plan = planUnknown([c]);
    const ch: RowChange = plan.changes[0];
    assert.equal(ch.before.reconcileStatus, "unmatched");
    assert.equal(ch.after.reconcileStatus, "unknown");
  });
});
