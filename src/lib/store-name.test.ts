import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  compareStoreNames,
  isFacilityTenant,
  noAutoCashReason,
  normalizeStoreName,
  ruleBasedStoreVerdict,
  storeAliasGroup,
} from "./store-name";

describe("正規化", () => {
  test("半角カナ・ひらがな・長音・空白・記号・法人格・支店名を吸収する", () => {
    assert.equal(normalizeStoreName("ｲｵﾝﾘﾃｰﾙ"), "イオンリテル");
    assert.equal(normalizeStoreName("イオン 渋谷店"), "イオン");
    assert.equal(normalizeStoreName("くら寿司鳩ヶ谷店"), "クラ寿司鳩ヶ谷");
    assert.equal(normalizeStoreName("株式会社 さみっと"), "サミット");
    assert.equal(normalizeStoreName("ＢｉＧ－Ａ"), "biga");
  });

  test("全角英数・全角ハイフン・中黒・連続空白を吸収する", () => {
    assert.equal(normalizeStoreName("セブン－イレブン・川口里中央店"), "セブンイレブン川口里中央");
    assert.equal(normalizeStoreName("ＥＴＣ　　ｺｰﾎﾟﾚｰﾄ"), "etcコポレト");
  });

  test("店舗コード・決済手段の付記・途中で切れた末尾の（ラ）を除く", () => {
    assert.equal(normalizeStoreName("ローソン　2529店"), "ロソン");
    assert.equal(normalizeStoreName("Amazon.co.jp CC171686515"), "amazoncojp");
    assert.equal(normalizeStoreName("サミット／NFC"), "サミット");
    assert.equal(
      normalizeStoreName("シンカテツクコウシキシヨツプラクテ（ラ）"),
      "シンカテツクコウシキシヨツプラクテ"
    );
  });
});

describe("文字列の類似度", () => {
  test("「イオン 渋谷店」と「ｲｵﾝﾘﾃｰﾙ」がマッチする", () => {
    assert.equal(compareStoreNames("イオン 渋谷店", "ｲｵﾝﾘﾃｰﾙ").similar, true);
    assert.equal(ruleBasedStoreVerdict("ｲｵﾝﾘﾃｰﾙ", "イオン 渋谷店"), "same");
  });

  test("表記ゆれ（半角カナ・店の有無・付記）でマッチする", () => {
    assert.equal(compareStoreNames("ｾﾌﾞﾝｲﾚﾌﾞﾝ", "セブン-イレブン 川口里中央店").similar, true);
    assert.equal(compareStoreNames("サミット／NFC", "サミットストア").similar, true);
    assert.equal(ruleBasedStoreVerdict("トモズ鳩ケ谷駅前店／NFC", "Tomod's トモズ鳩ヶ谷駅前店"), "same");
    assert.equal(
      compareStoreNames("マツモトキヨシぱぱす品川フロントビル店", "マツモトキヨシ 品川フロントビル店").similar,
      true
    );
  });

  test("全く別の店はマッチしない", () => {
    assert.equal(compareStoreNames("サミット", "ローソン").similar, false);
    assert.equal(compareStoreNames("マクドナルド", "無印良品").similar, false);
  });

  test("地名・駅名だけが共通する別の店はマッチしない", () => {
    assert.equal(compareStoreNames("サミット鳩ヶ谷駅前", "トモズ鳩ヶ谷駅前店").similar, false);
    assert.equal(compareStoreNames("クラ寿司鳩ヶ谷", "スシロー鳩ヶ谷").similar, false);
  });

  test("閾値は options で変更できる", () => {
    assert.equal(compareStoreNames("イオンバイク", "イオンスタイル").similar, true);
    assert.equal(
      compareStoreNames("イオンバイク", "イオンスタイル", { minCommonLength: 4 }).similar,
      false
    );
  });
});

describe("設定（別名辞書・施設名）", () => {
  test("英字表記とカナ表記を同じ店とみなす", () => {
    assert.equal(ruleBasedStoreVerdict("ビッグ・エー鳩ヶ谷駅前", "Big-A"), "same");
    assert.equal(ruleBasedStoreVerdict("ユーネクスト", "U-NEXT"), "same");
    assert.equal(ruleBasedStoreVerdict("ダイソー", "DAISO"), "same");
    assert.equal(ruleBasedStoreVerdict("セリア", "Seria"), "same");
    assert.equal(ruleBasedStoreVerdict("ローソン", "LAWSON 川口里店"), "same");
    assert.equal(storeAliasGroup("ＢｉＧ－Ａ"), "ビッグ・エー");
  });

  test("別々の別名グループは別の店", () => {
    assert.equal(ruleBasedStoreVerdict("ローソン", "セブン-イレブン"), "different");
  });

  test("カードの「イオンモール川口」は施設内テナント（イオンスタイル川口など）と照合し、前川は別の施設", () => {
    assert.equal(ruleBasedStoreVerdict("イオンモール川口", "イオンスタイル川口"), "same");
    assert.equal(ruleBasedStoreVerdict("イオンモール川口", "無印良品 イオンモール川口"), "same");
    assert.equal(ruleBasedStoreVerdict("イオンモール川口", "ローストビーフとハンバーグ YOSHIMI 川口店"), "same");
    assert.equal(isFacilityTenant("イオンモール川口", "ダイソー イオンモール川口前川店"), false);
    assert.equal(ruleBasedStoreVerdict("イオンモール川口", "イオンモール川口前川"), "different");
    assert.equal(ruleBasedStoreVerdict("イオンモール川口", "ダイソー イオンモール川口前川店"), "different");
    assert.equal(ruleBasedStoreVerdict("イオンモール川口前川", "イオンモール川口"), "different");
    assert.equal(ruleBasedStoreVerdict("イオンモール川口前川", "イオンスタイル川口"), "different");
  });

  test("「ストア」「サービス利用料」などの一般的な語だけが共通する店は似ていると判定しない", () => {
    assert.equal(compareStoreNames("エイミ―コウシキストア       （ラ", "サミットストア").similar, false);
    assert.equal(ruleBasedStoreVerdict("サミット／NFC", "サミットストア"), "same");
    assert.equal(ruleBasedStoreVerdict("ユーネクストサービス利用料", "U-NEXT"), "same");
    assert.equal(ruleBasedStoreVerdict("J：COM  サービス利用料", "J:COM利用料"), "same");
    assert.equal(ruleBasedStoreVerdict("ユーネクストサービス利用料", "J:COM利用料"), "different");
  });

  test("3文字程度の重なりだけで似ている別の店は、登録した組として different", () => {
    assert.equal(ruleBasedStoreVerdict("NINTENDO CC164469614", "ANDog"), "different");
    assert.equal(ruleBasedStoreVerdict("イオンバイク", "イオンスタイル川口"), "different");
    assert.equal(ruleBasedStoreVerdict("イオンバイク", "イオンモール川口"), "different");
    assert.equal(ruleBasedStoreVerdict("ヴィノスやまざき有楽町店", "デイリーヤマザキ JR鳩ケ谷駅店"), "different");
    assert.equal(ruleBasedStoreVerdict("くら寿司東川口店", "くら寿司 鳩ヶ谷店"), "different");
    assert.equal(
      ruleBasedStoreVerdict("マツモトキヨシぱぱす品川フロントビル店", "マツモトキヨシ 東川口駅前店"),
      "different"
    );
    assert.equal(ruleBasedStoreVerdict("ニトリネット", "ニトリ 鳩ヶ谷駅前店"), "different");
    assert.equal(ruleBasedStoreVerdict("くら寿司東川口店", "くら寿司 東川口店"), "same");
    assert.equal(ruleBasedStoreVerdict("ヴィノスやまざき有楽町店", "ヴィノスやまざき 有楽町店"), "same");
    assert.equal(ruleBasedStoreVerdict("イオンモール川口", "イオンスタイル川口"), "same");
  });

  test("ETC は現金への自動判定をしない（英字は語の境界で判定する）", () => {
    assert.equal(noAutoCashReason("ETC"), "ETC");
    assert.equal(noAutoCashReason("ＥＴＣ  関東支社"), "ETC");
    assert.equal(noAutoCashReason("Sketch Cafe"), null);
    assert.equal(noAutoCashReason("サミットストア"), null);
  });

  test("設定でも類似度でも決まらない組は null（AI・ユーザーの判定に回す）", () => {
    assert.equal(ruleBasedStoreVerdict("マクドナルド", "無印良品"), null);
  });
});
