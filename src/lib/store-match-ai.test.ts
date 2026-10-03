import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ANTHROPIC_API_KEY ??= "test-key";

const pairs = [
  { cardName: "ビッグ・エー鳩ヶ谷駅前", receiptName: "Big-A" },
  { cardName: "イオンリテール", receiptName: "セリア イオンモール川口店" },
  { cardName: "Vサガク125450", receiptName: "エディオン" },
];

test("自信度が閾値以上の same / different だけ採用し、それ以外は判定不可にする", async () => {
  const { parseStoreMatchAnswer } = await import("./store-match-ai");
  const answers = parseStoreMatchAnswer(
    `調べた結果です。
[
  {"index": 1, "verdict": "same", "confidence": 0.95, "merchant": "ビッグ・エー", "reason": "Big-A の運営"},
  {"index": 2, "verdict": "different", "confidence": 0.5, "merchant": null, "reason": "不明"}
]`,
    pairs
  );
  assert.deepEqual(
    answers.map((a) => a.verdict),
    ["same", "undetermined", "undetermined"]
  );
  assert.equal(answers[0].merchant, "ビッグ・エー");
  assert.match(answers[2].reason ?? "", /この組がありません/);
});

test("JSON が読めない回答はすべて判定不可", async () => {
  const { parseStoreMatchAnswer } = await import("./store-match-ai");
  const answers = parseStoreMatchAnswer("分かりませんでした", pairs);
  assert.ok(answers.every((a) => a.verdict === "undetermined"));
});

test("ユーザーが教えた判定をプロンプトに含める", async () => {
  const { buildStoreMatchPrompt } = await import("./store-match-ai");
  const prompt = buildStoreMatchPrompt(pairs.slice(0, 1), [
    { cardName: "ｴﾃﾞｨｵﾝ", receiptName: "EDION（返金）", verdict: "same", note: "家電量販店" },
  ]);
  assert.match(prompt, /カード「ｴﾃﾞｨｵﾝ」とレシート「EDION（返金）」は同じ店（家電量販店）/);
  assert.match(prompt, /1\. カード明細「ビッグ・エー鳩ヶ谷駅前」／ レシート「Big-A」/);
});
