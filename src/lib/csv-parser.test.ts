import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCsvStructure, mapMatrixToTransactions } from "./csv-parser";

test("情報行・合計行のある形式（日付・店名・金額・回数・回数・支払額）", () => {
  const matrix = [
    ["ヤマダ　タロウ　様", "4980-00**-****-****", "ゴールド／クレジット"],
    ["2026/06/05", "ウェルパーク向ヶ丘遊園南口店", "4771", "１", "１", "4771", ""],
    ["2026/06/06", "テックランド　向ヶ丘店", "29807", "１", "１", "29807", ""],
    ["2026/06/07", "返品　テックランド", "-500", "１", "１", "-500", ""],
    ["", "", "", "", "", "34078", ""],
  ];
  const s = detectCsvStructure(matrix);
  assert.ok(s);
  assert.equal(s.dateColumnIndex, 0);
  assert.equal(s.storeColumnIndex, 1);
  assert.equal(s.amountColumnIndex, 2);
  const txs = mapMatrixToTransactions(matrix, s);
  assert.deepEqual(
    txs.map((t) => [t.date, t.amount]),
    [
      ["2026-06-05", 4771],
      ["2026-06-06", 29807],
      ["2026-06-07", -500],
    ]
  );
});

test("利用者・支払区分の列がある形式では、左端の利用金額を選ぶ", () => {
  const matrix = [
    ["2026/9/30", "ローソン", "ご本人", "1回払い", "", "'26/10", "432", "432", "", ""],
    ["2026/9/29", "ビッグ・エー鳩ヶ谷駅前", "ご本人", "1回払い", "", "'26/10", "751", "751", "", ""],
    ["2026/8/24", "ＥＴＣ  関東支社", "ご本人", "1回払い", "", "'26/10", "1940", "1940", "", ""],
  ];
  const s = detectCsvStructure(matrix);
  assert.ok(s);
  assert.equal(s.dateColumnIndex, 0);
  assert.equal(s.storeColumnIndex, 1);
  assert.equal(s.amountColumnIndex, 6);
  assert.equal(mapMatrixToTransactions(matrix, s)[2].description, "ETC  関東支社");
});

test("日付の列が無ければ推定しない", () => {
  assert.equal(detectCsvStructure([["名前", "点数"], ["山田", "80"]]), null);
});
