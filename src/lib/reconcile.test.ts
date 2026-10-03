import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyReconcileToRows,
  buildReceiptUnits,
  buildReconcileSummary,
  cardCoverage,
  countsTowardTotals,
  finalizeUnmatchedReceiptsAsCash,
  initialReconcileFields,
  matchCardAndReceipts,
  planInitialReconcileState,
  toCardTransaction,
  type CardTransaction,
  type LedgerRow,
  type Receipt,
  type StoreJudge,
} from "./reconcile";

function card(id: string, date: string, storeName: string, amount: number): CardTransaction {
  return { id, date, storeName, amount, status: "unmatched", receiptId: null };
}

function receipt(
  id: string,
  date: string,
  storeName: string,
  amount: number,
  extra: Partial<Receipt> = {}
): Receipt {
  return {
    id,
    date,
    storeName,
    amount,
    paymentMethod: "unknown",
    status: "unmatched",
    cashSource: null,
    cardTransactionId: null,
    ...extra,
  };
}

function row(
  id: string,
  source: LedgerRow["source"],
  date: string,
  description: string,
  amount: number,
  extra: Partial<LedgerRow> = {}
): LedgerRow {
  return {
    id,
    date,
    description,
    amount,
    source,
    categoryId: null,
    memo: null,
    confirmed: true,
    archived: false,
    deletedAt: null,
    paymentMethod: source === "CSV" ? null : "unknown",
    reconcileStatus: "unmatched",
    cashSource: null,
    needsReview: false,
    receiptGroupId: null,
    matchedReceiptId: null,
    matchedCardId: null,
    autoCashExempt: false,
    rejectedCardIds: [],
    ...extra,
  };
}

const total = (rows: LedgerRow[]) =>
  rows.filter(countsTowardTotals).reduce((s, r) => s + r.amount, 0);

describe("matchCardAndReceipts: 成立条件", () => {
  test("金額が1円でも違えばマッチしない（日付が近くても遠くても）", () => {
    const near = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000)],
      [receipt("r1", "2026-08-10", "サミット 鳩ヶ谷駅前店", 999)]
    );
    const far = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000)],
      [receipt("r1", "2026-06-01", "サミット 鳩ヶ谷駅前店", 1001)]
    );
    assert.equal(near.matches.length, 0);
    assert.equal(far.matches.length, 0);
  });

  test("日付が30日離れていても、金額と店名が一致すれば突合される", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-31", "サミット／NFC", 3288)],
      [receipt("r1", "2026-08-01", "サミット 鳩ヶ谷駅前店", 3288)]
    );
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].dateDiffDays, -30);
    assert.equal(r.cards[0].status, "matched");
    assert.equal(r.cards[0].receiptId, "r1");
    assert.equal(r.receipts[0].status, "matched");
    assert.equal(r.receipts[0].cardTransactionId, "c1");
  });

  test("全く別の店はマッチしない", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-10", "マクドナルド", 500)],
      [receipt("r1", "2026-08-10", "ローソン", 500)]
    );
    assert.equal(r.matches.length, 0);
  });

  test("英字表記は、教えた／AIの判定（judgeStore）で同じ店ならマッチする", () => {
    const judge: StoreJudge = (c, rc) =>
      c.includes("ビッグ・エー") && rc.startsWith("Big-A") ? "same" : "different";
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-06", "ビッグ・エー鳩ヶ谷駅前", 910)],
      [receipt("r1", "2026-08-06", "Big-A", 910)],
      { judgeStore: judge }
    );
    assert.equal(r.matches.length, 1);
  });

  test("未判定・判定不可の組は突合せず unresolvedPairs に返す", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-06", "ビッグ・エー鳩ヶ谷駅前", 910)],
      [receipt("r1", "2026-08-06", "Big-A", 910)],
      { judgeStore: () => "pending" }
    );
    assert.equal(r.matches.length, 0);
    assert.deepEqual(
      r.unresolvedPairs.map((p) => [p.cardId, p.receiptId, p.verdict]),
      [["c1", "r1", "pending"]]
    );
  });
});

describe("matchCardAndReceipts: 割当の優先順位と1対1", () => {
  test("同額・同店舗の複数決済で、日付が最も近い組が優先される", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-01", "サミット", 1000), card("c2", "2026-08-20", "サミット", 1000)],
      [receipt("r1", "2026-08-19", "サミット", 1000), receipt("r2", "2026-08-01", "サミット", 1000)]
    );
    const pairs = Object.fromEntries(r.matches.map((m) => [m.cardId, m.receiptId]));
    assert.deepEqual(pairs, { c1: "r2", c2: "r1" });
  });

  test("レシート日付 <= カード日付 の候補がある場合は、そちらが優先される", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000)],
      [receipt("after", "2026-08-11", "サミット", 1000), receipt("before", "2026-08-07", "サミット", 1000)]
    );
    assert.equal(r.matches[0].receiptId, "before");
    assert.equal(r.matches[0].needsReview, false);
  });

  test("レシート日付がカード日付より後でも、他に候補が無ければ突合され needs_review になる", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000)],
      [receipt("r1", "2026-08-11", "サミット", 1000)]
    );
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].needsReview, true);
    assert.equal(r.cards[0].needsReview, true);
    assert.equal(r.receipts[0].needsReview, true);
  });

  test("日付差が14日を超える突合に needs_review が付き、14日以内には付かない", () => {
    const within = matchCardAndReceipts(
      [card("c1", "2026-08-15", "サミット", 1000)],
      [receipt("r1", "2026-08-01", "サミット", 1000)]
    );
    const over = matchCardAndReceipts(
      [card("c1", "2026-08-16", "サミット", 1000)],
      [receipt("r1", "2026-08-01", "サミット", 1000)]
    );
    assert.equal(within.matches[0].needsReview, false);
    assert.equal(over.matches[0].needsReview, true);
    const custom = matchCardAndReceipts(
      [card("c1", "2026-08-15", "サミット", 1000)],
      [receipt("r1", "2026-08-01", "サミット", 1000)],
      { reviewDays: 7 }
    );
    assert.equal(custom.matches[0].needsReview, true);
  });

  test("日付を制限しなくても、1枚のレシートが複数カードに（またはその逆に）紐付かない", () => {
    const r = matchCardAndReceipts(
      [
        card("c1", "2026-06-01", "サミット", 1000),
        card("c2", "2026-07-01", "サミット", 1000),
        card("c3", "2026-08-01", "サミット", 1000),
      ],
      [receipt("r1", "2026-07-15", "サミット", 1000), receipt("r2", "2026-01-01", "サミット", 1000)]
    );
    assert.equal(r.matches.length, 2);
    assert.equal(new Set(r.matches.map((m) => m.cardId)).size, 2);
    assert.equal(new Set(r.matches.map((m) => m.receiptId)).size, 2);
    assert.equal(r.cards.filter((c) => c.status === "unmatched").length, 1);
  });

  test("時刻・タイムゾーン付きの日付でも日付単位で比較する", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-10T23:59:00+09:00", "サミット", 1000)],
      [receipt("r1", "2026-08-10T00:00:00Z", "サミット", 1000)]
    );
    assert.equal(r.matches[0].dateDiffDays, 0);
    assert.equal(r.matches[0].needsReview, false);
  });
});

describe("matchCardAndReceipts: 対象外と冪等性", () => {
  test("現金レシート（confirmed・auto）は突合から除外される", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000), card("c2", "2026-08-10", "サミット", 2000)],
      [
        receipt("r1", "2026-08-10", "サミット", 1000, {
          paymentMethod: "cash",
          status: "cash",
          cashSource: "confirmed",
        }),
        receipt("r2", "2026-08-10", "サミット", 2000, {
          paymentMethod: "cash",
          status: "cash",
          cashSource: "auto",
        }),
      ]
    );
    assert.equal(r.matches.length, 0);
  });

  test("手動で解除した組（rejectedCardIds）は再突合しない", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000)],
      [receipt("r1", "2026-08-10", "サミット", 1000, { rejectedCardIds: ["c1"] })]
    );
    assert.equal(r.matches.length, 0);
  });

  test("2回実行しても結果が変わらない（matched は変更しない）", () => {
    const first = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000), card("c2", "2026-08-11", "サミット", 1000)],
      [receipt("r1", "2026-08-10", "サミット", 1000)]
    );
    const second = matchCardAndReceipts(first.cards, first.receipts);
    assert.equal(second.matches.length, 0);
    assert.deepEqual(second.cards, first.cards);
    assert.deepEqual(second.receipts, first.receipts);
  });

  test("入力を書き換えない（純関数）", () => {
    const cards = [card("c1", "2026-08-10", "サミット", 1000)];
    const receipts = [receipt("r1", "2026-08-10", "サミット", 1000)];
    const snapshot = JSON.stringify({ cards, receipts });
    matchCardAndReceipts(cards, receipts);
    assert.equal(JSON.stringify({ cards, receipts }), snapshot);
  });
});

describe("レシート単位の扱い", () => {
  test("商品ごとに分割登録されたレシートも、合計金額で突合される", () => {
    const rows = [
      row("i1", "IMAGE", "2026-08-02", "イオンスタイル川口 / 牛乳", 600, { receiptGroupId: "g1" }),
      row("i2", "IMAGE", "2026-08-02", "イオンスタイル川口 / 洗剤", 400, { receiptGroupId: "g1" }),
    ];
    const { units } = buildReceiptUnits(rows);
    assert.equal(units.length, 1);
    assert.equal(units[0].amount, 1000);
    assert.equal(units[0].storeName, "イオンスタイル川口");
    const r = matchCardAndReceipts([card("c1", "2026-08-03", "イオンリテール", 1000)], units);
    assert.equal(r.matches[0].receiptId, "g1");
  });

  test("レシートIDの無い旧形式の品目行は推測でまとめず、突合の対象外にする", () => {
    const rows = [
      row("i1", "IMAGE", "2026-08-04", "イオンスタイル川口 / ベーコン", 398),
      row("i2", "IMAGE", "2026-08-04", "イオンスタイル川口 / ほんだし", 278),
      row("m1", "MANUAL", "2026-08-04", "はま寿司", 2838),
    ];
    const { units, legacyLineItems } = buildReceiptUnits(rows);
    assert.deepEqual(units.map((u) => u.id), ["m1"]);
    assert.deepEqual(legacyLineItems.map((r) => r.id), ["i1", "i2"]);
  });
});

describe("finalizeUnmatchedReceiptsAsCash", () => {
  const coverage = cardCoverage(["2026-06-05", "2026-07-25"]);

  test("カードCSVの期間内（最新利用日の3日以上前）だけ cash(auto) にし、最近のレシートは unmatched のまま", () => {
    const { receipts, finalizedIds } = finalizeUnmatchedReceiptsAsCash(
      [
        receipt("in", "2026-07-22", "A", 100),
        receipt("recent", "2026-07-23", "B", 100),
        receipt("after", "2026-08-01", "C", 100),
        receipt("before", "2026-06-04", "D", 100),
        receipt("exempt", "2026-06-10", "E", 100, { autoCashExempt: true }),
        receipt("matched", "2026-06-10", "F", 100, { status: "matched" }),
      ],
      coverage
    );
    assert.deepEqual(finalizedIds, ["in"]);
    const byId = Object.fromEntries(receipts.map((r) => [r.id, r]));
    assert.deepEqual(
      [byId.in.status, byId.in.paymentMethod, byId.in.cashSource],
      ["cash", "cash", "auto"]
    );
    assert.equal(byId.recent.status, "unmatched");
    assert.equal(byId.after.status, "unmatched");
    assert.equal(byId.before.status, "unmatched");
    assert.equal(byId.exempt.status, "unmatched");
  });

  test("金額が一致するカード明細があり店名が判定待ちのレシートは、現金にしない", () => {
    const cards = [card("c1", "2026-07-01", "ビッグ・エー鳩ヶ谷駅前", 910)];
    const receipts = [receipt("r1", "2026-07-01", "Big-A", 910), receipt("r2", "2026-07-01", "八百屋", 300)];
    const matched = matchCardAndReceipts(cards, receipts, { judgeStore: () => "undetermined" });
    const { finalizedIds } = finalizeUnmatchedReceiptsAsCash(matched.receipts, coverage, {
      unresolvedPairs: matched.unresolvedPairs,
    });
    assert.deepEqual(finalizedIds, ["r2"]);
  });

  test("カード明細が1件も無ければ何もしない", () => {
    const result = finalizeUnmatchedReceiptsAsCash([receipt("r", "2026-07-01", "A", 1)], null);
    assert.deepEqual(result.finalizedIds, []);
  });
});

describe("集計（二重計上の防止と現金の計上）", () => {
  test("突合済みのカードとレシートで、合計支出がカード明細の金額と一致し、内訳合計もカード金額と一致する", () => {
    const rows = [
      row("c1", "CSV", "2026-08-03", "イオンリテール", 1000, { categoryId: "food" }),
      row("i1", "IMAGE", "2026-08-02", "イオンスタイル川口 / 牛乳", 600, {
        receiptGroupId: "g1",
        categoryId: "food",
      }),
      row("i2", "IMAGE", "2026-08-02", "イオンスタイル川口 / 洗剤", 400, {
        receiptGroupId: "g1",
        categoryId: "daily",
      }),
    ];
    const before = total(rows);
    assert.equal(before, 2000, "突合前はカードとレシートの両方が暫定で数えられている");

    const { units } = buildReceiptUnits(rows);
    const result = matchCardAndReceipts(rows.filter((r) => r.source === "CSV").map(toCardTransaction), units);
    const after = applyReconcileToRows(rows, units, result.matches);

    assert.equal(total(after), 1000);
    const byCategory = new Map<string, number>();
    for (const r of after.filter(countsTowardTotals)) {
      byCategory.set(r.categoryId!, (byCategory.get(r.categoryId!) ?? 0) + r.amount);
    }
    assert.deepEqual(Object.fromEntries(byCategory), { food: 600, daily: 400 });
    assert.equal([...byCategory.values()].reduce((s, n) => s + n, 0), 1000);
  });

  test("現金支出（手入力・confirmed・auto）は総支出に含まれ、CSV取込の前後で減らない", () => {
    const cashRows = [
      row("m1", "MANUAL", "2026-07-20", "テニス", 6050),
      row("r1", "IMAGE", "2026-07-10", "八百屋", 800, {
        paymentMethod: "cash",
        reconcileStatus: "cash",
        cashSource: "confirmed",
      }),
      row("r2", "IMAGE", "2026-07-11", "パン屋", 500),
    ];
    const beforeImport = total(cashRows);

    const cards = [row("c1", "CSV", "2026-07-25", "マクドナルド", 310)];
    const rows = [...cashRows, ...cards];
    const { units } = buildReceiptUnits(rows);
    const result = matchCardAndReceipts(cards.map(toCardTransaction), units);
    const finalized = finalizeUnmatchedReceiptsAsCash(
      result.receipts,
      cardCoverage(["2026-07-01", "2026-07-25"])
    );
    const after = applyReconcileToRows(rows, units, result.matches, finalized.finalizedIds);

    assert.deepEqual(finalized.finalizedIds.sort(), ["m1", "r2"]);
    assert.equal(total(after), beforeImport + 310);
    const summary = buildReconcileSummary(after);
    assert.equal(summary.cash, 6050 + 800 + 500);
    assert.equal(summary.cashConfirmed.amount, 800);
    assert.equal(summary.cashAuto.amount, 6550);
  });

  test("カード明細が未取込の期間のレシートは暫定の支出として数える", () => {
    const rows = [row("r1", "IMAGE", "2026-09-10", "サミット", 1200)];
    const summary = buildReconcileSummary(rows);
    assert.equal(summary.total, 1200);
    assert.equal(summary.provisional, 1200);
  });

  test("削除した Unknown・退避済みの行は数えない", () => {
    const rows = [
      row("u1", "CSV", "2026-06-08", "エディオン", -376772, {
        reconcileStatus: "unknown",
        deletedAt: new Date(),
      }),
      row("a1", "IMAGE", "2026-06-08", "旧品目", 100, { archived: true }),
    ];
    assert.equal(total(rows), 0);
  });
});

describe("可視化のサマリー", () => {
  test("件数・金額が元データと一致し、総支出 = カード分 + 現金分 + 暫定 + Unknown", () => {
    const rows = [
      row("c1", "CSV", "2026-08-03", "イオンリテール", 1000, {
        reconcileStatus: "matched",
        matchedReceiptId: "r1",
      }),
      row("r1", "IMAGE", "2026-08-02", "イオンスタイル川口", 1000, {
        reconcileStatus: "matched",
        matchedCardId: "c1",
      }),
      row("c2", "CSV", "2026-08-05", "ユーネクスト", 2600),
      row("c3", "CSV", "2026-08-06", "エディオン", -500, { reconcileStatus: "unknown" }),
      row("r2", "IMAGE", "2026-08-07", "パン屋", 300, {
        paymentMethod: "cash",
        reconcileStatus: "cash",
        cashSource: "confirmed",
      }),
      row("r3", "IMAGE", "2026-08-08", "八百屋", 200, {
        paymentMethod: "cash",
        reconcileStatus: "cash",
        cashSource: "auto",
      }),
      row("r4", "IMAGE", "2026-08-09", "サミット", 700),
    ];
    const s = buildReconcileSummary(rows);
    assert.equal(s.total, 1000 + 2600 - 500 + 300 + 200 + 700);
    assert.equal(s.card, 1000 + 2600);
    assert.equal(s.cash, 500);
    assert.equal(s.provisional, 700);
    assert.equal(s.adjustment, -500);
    assert.equal(s.total, s.card + s.cash + s.provisional + s.adjustment);
    assert.deepEqual(s.cardStatement, { amount: 3100, count: 3 });
    assert.deepEqual(s.matched, { amount: 1000, count: 1 });
    assert.deepEqual(s.unmatchedCards, { amount: 2600, count: 1 });
    assert.deepEqual(s.unmatchedReceipts, { amount: 700, count: 1 });
    assert.deepEqual(s.cashConfirmed, { amount: 300, count: 1 });
    assert.deepEqual(s.cashAuto, { amount: 200, count: 1 });
  });
});

describe("保存時と移行時の初期値", () => {
  test("OCRで現金と分かっていれば cash / confirmed、マイナス金額は Unknown", () => {
    assert.deepEqual(initialReconcileFields("IMAGE", 500, "cash"), {
      paymentMethod: "cash",
      reconcileStatus: "cash",
      cashSource: "confirmed",
    });
    assert.equal(initialReconcileFields("CSV", -376772).reconcileStatus, "unknown");
    assert.deepEqual(initialReconcileFields("CSV", 1000), {
      paymentMethod: null,
      reconcileStatus: "unmatched",
      cashSource: null,
    });
  });

  test("マイグレーション: 既存の現金データは cash として移行され、突合の対象にならない", () => {
    const rows = [
      row("cash1", "MANUAL", "2026-07-10", "サミット", 1000),
      row("card1", "CSV", "2026-07-10", "サミット", 1000),
      row("img1", "IMAGE", "2026-06-08", "エディオン", 376772),
    ];
    const sets = { cashIds: new Set(["cash1"]), exemptIds: new Set(["img1"]) };
    const migrated = rows.map((r) => ({ ...r, ...planInitialReconcileState(r, sets) }));
    const byId = Object.fromEntries(migrated.map((r) => [r.id, r]));
    assert.deepEqual(
      [byId.cash1.paymentMethod, byId.cash1.reconcileStatus, byId.cash1.cashSource],
      ["cash", "cash", "confirmed"]
    );
    assert.deepEqual([byId.card1.paymentMethod, byId.card1.reconcileStatus], [null, "unmatched"]);
    assert.deepEqual([byId.img1.paymentMethod, byId.img1.autoCashExempt], ["unknown", true]);

    const { units } = buildReceiptUnits(migrated);
    const result = matchCardAndReceipts(
      migrated.filter((r) => r.source === "CSV").map(toCardTransaction),
      units
    );
    assert.equal(result.matches.length, 0);
    assert.equal(total(migrated), total(rows));
  });
});
