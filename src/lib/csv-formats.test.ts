import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectCardCsvFormat, parsePaymentMonth } from "./csv-formats";
import { mapMatrixToTransactions, normalizeDate } from "./csv-parser";

/** 実ファイル 202610.csv と同じ並び（ヘッダーなし・13列） */
const row13 = (date: string, store: string, amount: string) => [
  date, store, "ご本人", "1回払い", "", "'26/10", amount, amount, "", "", "", "", "",
];

describe("カードCSV（ヘッダーなし・13列）", () => {
  const matrix = [
    row13("2026/9/30", "ローソン", "432"),
    row13("2026/9/30", "イオンモール川口", "1199"),
    row13("2026/9/12", "ｾﾌﾞﾝｲﾚﾌﾞﾝ", "660"),
    row13("2026/9/12", "ｾﾌﾞﾝｲﾚﾌﾞﾝ", "1288"),
    row13("2026/8/24", "ＥＴＣ　　関東支社", "1940"),
    row13("2026/8/24", "ＥＴＣ　　関東支社", "1940"),
  ];

  test("列の位置の設定で読み、利用日・店名・利用金額を取り出す", () => {
    const detected = detectCardCsvFormat(matrix);
    assert.ok(detected);
    assert.equal(detected.format.id, "card-13col");
    assert.equal(detected.structure.dateColumnIndex, 0);
    assert.equal(detected.structure.storeColumnIndex, 1);
    assert.equal(detected.structure.amountColumnIndex, 6);
    assert.equal(detected.paymentMonth, "2026-10");

    const txs = mapMatrixToTransactions(matrix, detected.structure);
    assert.equal(txs.length, 6, "同日・同店・同額の行も落とさない");
    assert.deepEqual(txs[0], { ...txs[0], date: "2026-09-30", description: "ローソン", amount: 432 });
  });

  test("月は利用日だけで決まる（支払月・ファイル名の 202610 は使わない）", () => {
    const detected = detectCardCsvFormat(matrix)!;
    const months = new Set(mapMatrixToTransactions(matrix, detected.structure).map((t) => t.date.slice(0, 7)));
    assert.deepEqual([...months].sort(), ["2026-08", "2026-09"]);
  });

  test("支払月の表記を YYYY-MM に変換する", () => {
    assert.equal(parsePaymentMonth("'26/10"), "2026-10");
    assert.equal(parsePaymentMonth("26/1"), "2026-01");
    assert.equal(parsePaymentMonth("'26/13"), null);
    assert.equal(parsePaymentMonth("2026/10/01"), null);
  });
});

describe("カードCSV（7列・氏名行と合計行あり）", () => {
  test("先頭の氏名行と末尾の合計行を除いて読む", () => {
    const matrix = [
      ["ヤマダ　タロウ　様", "4980-00**-****-****", "ゴールド／クレジット"],
      ["2026/06/05", "ウェルパーク向ヶ丘遊園南口店", "4771", "１", "１", "4771", ""],
      ["2026/06/29", "くら寿司鳩ヶ谷店", "2460", "１", "１", "2460", ""],
      ["", "", "", "", "", "7231", ""],
    ];
    const detected = detectCardCsvFormat(matrix);
    assert.ok(detected);
    assert.equal(detected.format.id, "olive-7col");
    assert.equal(detected.paymentMonth, null);
    assert.deepEqual(
      mapMatrixToTransactions(matrix, detected.structure).map((t) => [t.date, t.amount]),
      [
        ["2026-06-05", 4771],
        ["2026-06-29", 2460],
      ]
    );
  });
});

test("設定に無い形式は null（AI・推定に回す）", () => {
  assert.equal(
    detectCardCsvFormat([
      ["日付", "内容", "金額"],
      ["2026/9/1", "A", "100"],
    ]),
    null
  );
});

describe("年の無い日付（レシート・明細の画像）", () => {
  test("基準日以前で最も近い年として解釈する（今日の日付を直書きしない）", () => {
    const ref = new Date(2026, 9, 3);
    assert.equal(normalizeDate("9/30", undefined, ref), "2026-09-30");
    assert.equal(normalizeDate("10/3", undefined, ref), "2026-10-03");
    assert.equal(normalizeDate("10/4", undefined, ref), "2025-10-04");
    assert.equal(normalizeDate("12月31日", undefined, new Date(2027, 0, 5)), "2026-12-31");
    assert.equal(normalizeDate("2/30", undefined, ref), null);
  });

  test("年がある日付は基準日に関係なくそのまま", () => {
    assert.equal(normalizeDate("2026/8/24", undefined, new Date(2030, 0, 1)), "2026-08-24");
  });
});
