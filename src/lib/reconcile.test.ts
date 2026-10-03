import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  applyReconcileToRows,
  assignDuplicateIndexes,
  buildImportCoverages,
  buildReceiptUnits,
  buildReconcileSummary,
  countsTowardTotals,
  coverageSegments,
  describeImportCoverage,
  diffDays,
  finalizeUnmatchedReceiptsAsCash,
  findOutOfRangeMatches,
  initialReconcileFields,
  isTaxInclusiveAmount,
  matchCardAndReceipts,
  planInitialReconcileState,
  toCardTransaction,
  type CardTransaction,
  type LedgerRow,
  type Receipt,
  type StoreJudge,
} from "./reconcile";

/** from〜to の毎日（カード明細が隙間なくある期間の再現用） */
function daily(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 実ファイル 202610.csv（支払月 2026/10）の利用日の分布。8/24 の ETC 4件 + 9月 56件 */
const CSV_202610_DATES = [
  ...Array(4).fill("2026-08-24"),
  ...Object.entries({
    1: 1, 2: 1, 3: 1, 4: 1, 5: 7, 6: 3, 7: 2, 8: 1, 10: 1, 11: 2, 12: 5, 13: 4, 14: 1,
    16: 1, 17: 2, 22: 5, 23: 3, 25: 2, 26: 6, 27: 1, 28: 1, 29: 3, 30: 2,
  }).flatMap(([d, n]) => Array(n).fill(`2026-09-${String(d).padStart(2, "0")}`)),
];

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

describe("matchCardAndReceipts: 日付の窓（利用日の前後31日）", () => {
  test("31日以内は候補、32日以上離れた組は金額・店名が一致しても突合しない", () => {
    const at31 = matchCardAndReceipts(
      [card("c1", "2026-09-01", "サミット", 1000)],
      [receipt("r1", "2026-08-01", "サミット", 1000)]
    );
    const at32 = matchCardAndReceipts(
      [card("c1", "2026-09-02", "サミット", 1000)],
      [receipt("r1", "2026-08-01", "サミット", 1000)]
    );
    assert.equal(at31.matches.length, 1);
    assert.equal(at32.matches.length, 0);
  });

  test("9月のレシートは7月の明細と照合されない（本番で起きていた誤照合の再現）", () => {
    const r = matchCardAndReceipts(
      [
        card("c-jun", "2026-06-06", "ネクストオンライン", 3480),
        card("c-jul", "2026-06-28", "イオンモール川口", 660),
      ],
      [
        receipt("r-sep", "2026-09-26", "ネクストオンライン", 3480),
        receipt("r-sep2", "2026-09-12", "イオンスタイル川口", 660),
      ]
    );
    assert.equal(r.matches.length, 0);
    assert.equal(r.unresolvedPairs.length, 0, "窓の外の組は AI にも問い合わせない");
    assert.deepEqual(
      r.receipts.map((x) => x.unmatchedReason),
      ["no_csv_coverage", "no_csv_coverage"]
    );
  });

  test("窓は options.maxDays で変更できる", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-11", "サミット", 1000)],
      [receipt("r1", "2026-08-01", "サミット", 1000)],
      { maxDays: 7 }
    );
    assert.equal(r.matches.length, 0);
  });

  test("未照合の理由: 前後31日にカード明細が無ければ no_csv_coverage、あれば no_candidate", () => {
    const r = matchCardAndReceipts(
      [
        card("c1", "2026-07-25", "マクドナルド", 310),
        card("c-neg", "2026-09-30", "エディオン", -500),
      ],
      [
        receipt("near", "2026-08-20", "八百屋", 800),
        receipt("far", "2026-08-30", "八百屋", 800),
        receipt("cash", "2026-08-20", "パン屋", 300, { paymentMethod: "cash", status: "cash" }),
      ]
    );
    const byId = Object.fromEntries(r.receipts.map((x) => [x.id, x]));
    assert.equal(byId.near.unmatchedReason, "no_candidate");
    assert.equal(byId.far.unmatchedReason, "no_candidate", "マイナス金額の明細も取込済みの利用日として数える");
    assert.equal(byId.cash.unmatchedReason, undefined, "現金レシートには理由を付けない");

    const none = matchCardAndReceipts([card("c1", "2026-06-05", "A", 1)], [receipt("r", "2026-09-10", "B", 2)]);
    assert.equal(none.receipts[0].unmatchedReason, "no_csv_coverage");
  });

  test("照合できたレシートの理由は消える", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-08-10", "サミット", 1000)],
      [receipt("r1", "2026-08-10", "サミット", 1000, { unmatchedReason: "no_csv_coverage" })]
    );
    assert.equal(r.receipts[0].unmatchedReason, null);
  });

  test("既定の店名判定（辞書・類似度）で「ｲｵﾝﾘﾃｰﾙ」と「イオン 渋谷店」が照合される", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-09-02", "ｲｵﾝﾘﾃｰﾙ", 2480)],
      [receipt("r1", "2026-09-01", "イオン 渋谷店", 2480)]
    );
    assert.equal(r.matches.length, 1);
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

  test("1枚のレシートが複数カードに（またはその逆に）紐付かない", () => {
    const r = matchCardAndReceipts(
      [
        card("c1", "2026-08-01", "サミット", 1000),
        card("c2", "2026-08-10", "サミット", 1000),
        card("c3", "2026-08-20", "サミット", 1000),
      ],
      [receipt("r1", "2026-08-09", "サミット", 1000), receipt("r2", "2026-08-15", "サミット", 1000)]
    );
    assert.equal(r.matches.length, 2);
    assert.equal(new Set(r.matches.map((m) => m.cardId)).size, 2);
    assert.equal(new Set(r.matches.map((m) => m.receiptId)).size, 2);
    assert.deepEqual(
      Object.fromEntries(r.matches.map((m) => [m.cardId, m.receiptId])),
      { c2: "r1", c3: "r2" }
    );
    assert.equal(r.cards.find((c) => c.id === "c1")?.status, "unmatched");
  });

  test("同日・同店舗で金額違いの複数決済は、それぞれ同額のレシートと組になる", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-09-12", "ｾﾌﾞﾝｲﾚﾌﾞﾝ", 660), card("c2", "2026-09-12", "ｾﾌﾞﾝｲﾚﾌﾞﾝ", 1288)],
      [
        receipt("r1", "2026-09-12", "セブン-イレブン 川口里中央店", 1288),
        receipt("r2", "2026-09-12", "セブン-イレブン 川口里中央店", 660),
      ]
    );
    assert.deepEqual(
      Object.fromEntries(r.matches.map((m) => [m.cardId, m.receiptId])),
      { c1: "r2", c2: "r1" }
    );
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

describe("取込ごとの対象期間（coverage）", () => {
  test("202610.csv の実分布: 8/24 の4件は外れ値として除き、9/1〜9/30 を対象期間にする", () => {
    assert.equal(CSV_202610_DATES.length, 60);
    const segs = coverageSegments(CSV_202610_DATES);
    assert.deepEqual(segs, [{ from: "2026-09-01", to: "2026-09-30", count: 56 }]);
    const [cov] = buildImportCoverages(CSV_202610_DATES.map((date) => ({ date, importBatchId: "b10" })));
    assert.deepEqual([cov.from, cov.to, cov.count], ["2026-08-24", "2026-09-30", 60]);
  });

  test("7日以上の空白で分け、1割を超える塊はどちらも残す", () => {
    const dates = [...daily("2026-06-05", "2026-06-29"), ...daily("2026-07-10", "2026-07-25")];
    assert.deepEqual(
      coverageSegments(dates).map((s) => [s.from, s.to]),
      [
        ["2026-06-05", "2026-06-29"],
        ["2026-07-10", "2026-07-25"],
      ]
    );
    assert.equal(coverageSegments([...daily("2026-06-05", "2026-06-29"), "2026-07-02"]).length, 1, "3日の空白は同じ塊");
  });

  test("取込（importBatchId）ごとに別の期間になり、取込の間の空白は期間に含まれない", () => {
    const covs = buildImportCoverages([
      ...daily("2026-06-05", "2026-07-25").map((date) => ({ date, importBatchId: null })),
      ...CSV_202610_DATES.map((date) => ({ date, importBatchId: "b10" })),
    ]);
    assert.deepEqual(
      covs.map((c) => [c.batchId, c.segments.map((s) => `${s.from}~${s.to}`)]),
      [
        ["legacy", ["2026-06-05~2026-07-25"]],
        ["b10", ["2026-09-01~2026-09-30"]],
      ]
    );
  });
});

describe("finalizeUnmatchedReceiptsAsCash", () => {
  const coverage = buildImportCoverages(daily("2026-06-05", "2026-07-25").map((date) => ({ date })));

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
    const result = finalizeUnmatchedReceiptsAsCash([receipt("r", "2026-07-01", "A", 1)], []);
    assert.deepEqual(result.finalizedIds, []);
  });

  test("取込の間の空白（7/26〜8/31）と、外れ値の 8/24 付近のレシートは現金にしない", () => {
    const covs = buildImportCoverages([
      ...daily("2026-06-05", "2026-07-25").map((date) => ({ date, importBatchId: "b08" })),
      ...CSV_202610_DATES.map((date) => ({ date, importBatchId: "b10" })),
    ]);
    const receipts = [
      receipt("gap-early", "2026-07-28", "A", 100),
      receipt("gap-mid", "2026-08-10", "A", 100),
      receipt("etc-day", "2026-08-24", "A", 100),
      receipt("aug-end", "2026-08-31", "A", 100),
      receipt("sep-in", "2026-09-10", "A", 100),
      receipt("sep-edge", "2026-09-27", "A", 100),
      receipt("sep-recent", "2026-09-28", "A", 100),
      receipt("oct", "2026-10-02", "A", 100),
    ];
    const { finalizedIds } = finalizeUnmatchedReceiptsAsCash(receipts, covs);
    assert.deepEqual(finalizedIds, ["sep-in", "sep-edge"]);
  });

  test("税抜で読み取ったとみられるレシート（同じ店でカード金額が税込換算に当たる）は現金にしない", () => {
    const cards = [
      card("c1", "2026-07-10", "ビッグ・エー鳩ヶ谷駅前", 287),
      card("c2", "2026-07-10", "セリア2529イオンモ-ル川口店", 330),
    ];
    const receipts = [
      receipt("big-a", "2026-07-10", "Big-A 九鶴ヶ谷駅前店", 266),
      receipt("seria", "2026-07-10", "Seria イオンモール川口店", 300),
      receipt("other", "2026-07-10", "八百屋", 300),
    ];
    const matched = matchCardAndReceipts(cards, receipts);
    assert.equal(matched.matches.length, 0);
    assert.deepEqual(
      matched.taxCandidatePairs.map((p) => [p.cardId, p.receiptId]),
      [
        ["c1", "big-a"],
        ["c2", "seria"],
      ]
    );
    const { finalizedIds } = finalizeUnmatchedReceiptsAsCash(matched.receipts, coverage, {
      taxCandidatePairs: matched.taxCandidatePairs,
    });
    assert.deepEqual(finalizedIds, ["other"]);
  });

  test("no_csv_coverage のレシートは、期間の内側でも現金にしない", () => {
    const { finalizedIds } = finalizeUnmatchedReceiptsAsCash(
      [receipt("r", "2026-07-01", "A", 100, { unmatchedReason: "no_csv_coverage" })],
      coverage
    );
    assert.deepEqual(finalizedIds, []);
  });

  test("現金にしたレシートの未照合の理由は消える", () => {
    const { receipts } = finalizeUnmatchedReceiptsAsCash(
      [receipt("r", "2026-07-01", "A", 100, { unmatchedReason: "no_candidate" })],
      coverage
    );
    assert.equal(receipts[0].unmatchedReason, null);
  });

  test("余白の日数は options.marginDays で変更できる", () => {
    const r = [receipt("r", "2026-07-20", "A", 100)];
    assert.deepEqual(finalizeUnmatchedReceiptsAsCash(r, coverage).finalizedIds, ["r"]);
    assert.deepEqual(finalizeUnmatchedReceiptsAsCash(r, coverage, { marginDays: 7 }).finalizedIds, []);
  });
});

describe("税込換算の判定", () => {
  test("8%・10%の切捨て・四捨五入・切上げ、8%と10%の混在に当たる金額だけを候補にする", () => {
    assert.equal(isTaxInclusiveAmount(266, 287), true);
    assert.equal(isTaxInclusiveAmount(300, 330), true);
    assert.equal(isTaxInclusiveAmount(4149, 4486), true, "8%と10%の混在");
    assert.equal(isTaxInclusiveAmount(1000, 1000), false, "同額は通常の突合");
    assert.equal(isTaxInclusiveAmount(1000, 1070), false);
    assert.equal(isTaxInclusiveAmount(1000, 1102), false);
    assert.equal(isTaxInclusiveAmount(1000, 900), false);
  });

  test("別の店・窓の外の組は税込換算の候補にしない", () => {
    const r = matchCardAndReceipts(
      [card("c1", "2026-09-01", "ビッグ・エー鳩ヶ谷駅前", 287), card("c2", "2026-07-01", "セリア", 330)],
      [receipt("r1", "2026-09-01", "ローソン", 266), receipt("r2", "2026-09-01", "Seria", 300)]
    );
    assert.deepEqual(r.taxCandidatePairs, []);
  });
});

describe("誤突合の検出（自動では解除しない）", () => {
  test("日付差が31日を超える既存の照合だけを一覧にする", () => {
    const rows = [
      row("c-far", "CSV", "2026-06-06", "ネクストオンライン", 3480, {
        reconcileStatus: "matched",
        matchedReceiptId: "g1",
      }),
      row("i1", "IMAGE", "2026-09-26", "銀座ロフト / A", 3000, {
        reconcileStatus: "matched",
        matchedCardId: "c-far",
        receiptGroupId: "g1",
      }),
      row("i2", "IMAGE", "2026-09-26", "銀座ロフト / B", 480, {
        reconcileStatus: "matched",
        matchedCardId: "c-far",
        receiptGroupId: "g1",
      }),
      row("c-ok", "CSV", "2026-09-01", "サミット", 1000, { reconcileStatus: "matched", matchedReceiptId: "r2" }),
      row("r2", "IMAGE", "2026-08-01", "サミット", 1000, { reconcileStatus: "matched", matchedCardId: "c-ok" }),
    ];
    const found = findOutOfRangeMatches(rows);
    assert.deepEqual(found, [
      {
        cardId: "c-far",
        receiptRowIds: ["i1", "i2"],
        cardDate: "2026-06-06",
        receiptDate: "2026-09-26",
        dateDiffDays: 112,
      },
    ]);
    assert.equal(diffDays("2026-08-01", "2026-09-01"), 31);
    assert.equal(rows[0].reconcileStatus, "matched", "入力は書き換えない");
  });
});

describe("CSV取込の重複判定キー（日付・店名・金額・何件目か）", () => {
  const base = [
    { date: "2026-08-24", description: "ETC", amount: 1200 },
    { date: "2026-08-24", description: "ETC", amount: 1200 },
    { date: "2026-08-24", description: "ETC", amount: 850 },
    { date: "2026-08-24", description: "ETC", amount: 1200 },
  ];
  const key = (r: { date: string; description: string; amount: number; dupIndex: number }) =>
    `${r.date}|${r.description}|${r.amount}|${r.dupIndex}`;

  test("同日・同店・同額の明細を取りこぼさない", () => {
    const keys = assignDuplicateIndexes(base).map(key);
    assert.equal(new Set(keys).size, 4);
    assert.deepEqual(
      assignDuplicateIndexes(base).map((r) => r.dupIndex),
      [0, 1, 0, 2]
    );
  });

  test("同じCSVを再取込すると同じキーになり、二重登録されない", () => {
    const first = new Set(assignDuplicateIndexes(base).map(key));
    const again = assignDuplicateIndexes(base).map(key);
    assert.equal(again.filter((k) => !first.has(k)).length, 0);
  });

  test("期間が重なる別のCSVの同じ明細も同じキーになる", () => {
    const fileA = [{ date: "2026-07-25", description: "マクドナルド", amount: 310 }];
    const fileB = [
      { date: "2026-07-25", description: "マクドナルド", amount: 310 },
      { date: "2026-08-24", description: "ETC", amount: 1200 },
    ];
    const existing = new Set(assignDuplicateIndexes(fileA).map(key));
    const newRows = assignDuplicateIndexes(fileB).filter((r) => !existing.has(key(r)));
    assert.deepEqual(newRows.map((r) => r.description), ["ETC"]);
  });
});

describe("取込完了時のメッセージ", () => {
  test("利用日の範囲を示し、ファイル名の年月は支払月だと明記する", () => {
    const info = describeImportCoverage({
      fileName: "202610.csv",
      paymentMonth: "2026-10",
      dates: CSV_202610_DATES,
    });
    assert.equal(info?.from, "2026-08-24");
    assert.equal(info?.to, "2026-09-30");
    assert.match(info!.message, /2026\/8\/24〜2026\/9\/30/);
    assert.match(info!.message, /202610は支払月/);
    assert.equal(info?.warning, null);
  });

  test("未照合のレシートの期間と重ならなければ警告する", () => {
    const disjoint = describeImportCoverage({
      fileName: "202608.csv",
      dates: daily("2026-07-02", "2026-07-25"),
      unmatchedReceiptDates: ["2026-09-01", "2026-09-26"],
    });
    assert.match(disjoint!.warning!, /2026\/9\/1〜2026\/9\/26/);
    const overlap = describeImportCoverage({
      fileName: "202610.csv",
      dates: CSV_202610_DATES,
      unmatchedReceiptDates: ["2026-07-30", "2026-09-26"],
    });
    assert.equal(overlap?.warning, null);
  });

  test("利用日が無ければ null", () => {
    assert.equal(describeImportCoverage({ dates: [] }), null);
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
      buildImportCoverages(daily("2026-07-01", "2026-07-25").map((date) => ({ date })))
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

  test("未照合のレシートを理由別に数え、内訳の合計が未照合の合計と一致する", () => {
    const rows = [
      row("c1", "CSV", "2026-07-25", "マクドナルド", 310),
      row("r1", "IMAGE", "2026-07-20", "八百屋", 800),
      row("r2", "IMAGE", "2026-09-10", "サミット", 1200),
      row("i1", "IMAGE", "2026-09-12", "セブン / おにぎり", 160, { receiptGroupId: "g" }),
      row("i2", "IMAGE", "2026-09-12", "セブン / お茶", 140, { receiptGroupId: "g" }),
    ];
    const { units } = buildReceiptUnits(rows);
    const result = matchCardAndReceipts(rows.filter((r) => r.source === "CSV").map(toCardTransaction), units);
    const after = applyReconcileToRows(rows, units, result.matches, [], result.receipts);
    const byId = Object.fromEntries(after.map((r) => [r.id, r]));
    assert.equal(byId.r1.unmatchedReason, "no_candidate");
    assert.equal(byId.r2.unmatchedReason, "no_csv_coverage");
    assert.equal(byId.i2.unmatchedReason, "no_csv_coverage", "レシートの全行に理由が付く");

    const s = buildReconcileSummary(after);
    assert.deepEqual(s.unmatchedNoCandidate, { amount: 800, count: 1 });
    assert.deepEqual(s.unmatchedNoCoverage, { amount: 1500, count: 2 });
    assert.equal(
      s.unmatchedNoCandidate.amount + s.unmatchedNoCoverage.amount,
      s.unmatchedReceipts.amount
    );
    assert.equal(s.total, 310 + 800 + 1200 + 300, "未照合のレシートも暫定で総支出に入る");
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
