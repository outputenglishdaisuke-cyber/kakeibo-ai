import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtractedImageTransaction } from "@/types";
import { alignReceiptToTotal } from "./receipt-total";

const item = (itemName: string | null, amount: number, categoryName: string | null = "食費"): ExtractedImageTransaction => ({
  date: "2026-09-01",
  storeName: "Big-A 鳩ヶ谷駅前店",
  itemName,
  description: itemName ? `Big-A 鳩ヶ谷駅前店 / ${itemName}` : "Big-A 鳩ヶ谷駅前店",
  amount,
  categoryName,
  paymentMethod: "credit_card",
});
const sum = (xs: ExtractedImageTransaction[]) => xs.reduce((s, x) => s + x.amount, 0);

describe("レシートを税込の合計にそろえる", () => {
  test("税抜表示のレシート（実例: 178+88=266、支払287）は消費税21円の行を加え、合計がカード金額と一致する", () => {
    const r = alignReceiptToTotal([item("流水麺", 178), item("納豆", 88)], 287);
    assert.equal(sum(r.items), 287);
    assert.equal(r.adjustment, 21);
    assert.equal(r.warning, null);
    const tax = r.items.at(-1)!;
    assert.deepEqual([tax.itemName, tax.amount, tax.categoryName], ["消費税", 21, "食費"]);
    assert.equal(tax.description, "Big-A 鳩ヶ谷駅前店 / 消費税");
    assert.equal(tax.paymentMethod, "credit_card");
  });

  test("カテゴリが複数なら、消費税を小計の比で分けて合計を合わせる", () => {
    const r = alignReceiptToTotal(
      [item("牛乳", 1000, "食費"), item("洗剤", 500, "日用品")],
      1000 + 80 + 500 + 50
    );
    assert.equal(sum(r.items), 1630);
    const taxLines = r.items.filter((i) => i.itemName?.startsWith("消費税"));
    assert.deepEqual(
      taxLines.map((t) => [t.itemName, t.categoryName, t.amount]),
      [
        ["消費税（食費）", "食費", 87],
        ["消費税（日用品）", "日用品", 43],
      ]
    );
  });

  test("税込表示で合計と一致すれば何もしない", () => {
    const items = [item("おにぎり", 160), item("お茶", 140)];
    const r = alignReceiptToTotal(items, 300);
    assert.deepEqual(r.items, items);
    assert.equal(r.adjustment, 0);
  });

  test("差が税として説明できない場合は「調整」の行にして確認を促す", () => {
    const less = alignReceiptToTotal([item("A", 1000), item("B", 500)], 1400);
    assert.equal(sum(less.items), 1400);
    assert.equal(less.items.at(-1)!.itemName, "調整（レシート合計との差）");
    assert.match(less.warning!, /1500円.*1400円/);

    const more = alignReceiptToTotal([item("A", 1000)], 1300);
    assert.equal(sum(more.items), 1300);
    assert.ok(more.warning);
  });

  test("合計が読めなければ推測で直さず、確認を促す", () => {
    const items = [item("A", 100)];
    const r = alignReceiptToTotal(items, null);
    assert.deepEqual(r.items, items);
    assert.match(r.warning!, /合計金額を読み取れなかった/);
  });

  test("品目の無い1件（店名だけ）は合計金額をそのまま使う。利用明細の画像（合計なし）は何もしない", () => {
    assert.equal(alignReceiptToTotal([item(null, 3480)], 3828).items[0].amount, 3828);
    const statement = [item(null, 432), item(null, 1199)];
    assert.deepEqual(alignReceiptToTotal(statement, null), { items: statement, adjustment: 0, warning: null });
  });

  test("値引の行（負の金額）があっても合計を合わせる", () => {
    const r = alignReceiptToTotal([item("たまごサンド", 198), item("値引", -40), item("うなぎ", 798)], 1031);
    assert.equal(sum(r.items), 1031);
    assert.equal(r.warning, null);
  });
});
