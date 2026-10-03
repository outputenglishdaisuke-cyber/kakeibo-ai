import { test } from "node:test";
import assert from "node:assert/strict";
import { compareStoreNames, normalizeStoreName } from "./store-name";

test("正規化: 半角カナ・ひらがな・空白・記号・法人格・支店名を吸収する", () => {
  assert.equal(normalizeStoreName("ｲｵﾝﾘﾃｰﾙ"), "イオンリテール");
  assert.equal(normalizeStoreName("イオン 渋谷店"), "イオン");
  assert.equal(normalizeStoreName("くら寿司鳩ヶ谷店"), "クラ寿司鳩ヶ谷");
  assert.equal(normalizeStoreName("株式会社 さみっと"), "サミット");
  assert.equal(normalizeStoreName("ＢｉＧ－Ａ"), "biga");
});

test("「イオン 渋谷店」と「ｲｵﾝﾘﾃｰﾙ」がマッチする", () => {
  assert.equal(compareStoreNames("イオン 渋谷店", "ｲｵﾝﾘﾃｰﾙ").similar, true);
});

test("表記ゆれ（半角カナ・店の有無）でマッチする", () => {
  assert.equal(compareStoreNames("ｾﾌﾞﾝｲﾚﾌﾞﾝ", "セブン-イレブン 川口里中央店").similar, true);
  assert.equal(compareStoreNames("サミット／NFC", "サミットストア").similar, true);
  assert.equal(compareStoreNames("トモズ鳩ケ谷駅前店／NFC", "Tomod's トモズ鳩ヶ谷駅前店").similar, true);
});

test("全く別の店はマッチしない", () => {
  assert.equal(compareStoreNames("サミット", "ローソン").similar, false);
  assert.equal(compareStoreNames("マクドナルド", "無印良品").similar, false);
});

test("閾値は options で変更できる", () => {
  assert.equal(compareStoreNames("イオンバイク", "イオンスタイル").similar, true);
  assert.equal(
    compareStoreNames("イオンバイク", "イオンスタイル", { minCommonLength: 4 }).similar,
    false
  );
});
