/**
 * カード明細の店名とレシートの店名が同じ店かを、Web 検索つきの Claude に判定させる。
 * サーバー専用（anthropic を import するため）。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL } from "@/lib/anthropic";

/** この自信度未満の「同じ店」「別の店」は判定不可として扱う */
export const AI_MIN_CONFIDENCE = 0.7;
const PAIRS_PER_REQUEST = 6;
const MAX_SEARCHES_PER_REQUEST = 8;
const MAX_CONTINUATIONS = 3;

export interface StorePairQuestion {
  cardName: string;
  receiptName: string;
}

export interface TaughtExample {
  cardName: string;
  receiptName: string;
  verdict: "same" | "different";
  note?: string | null;
}

export interface StorePairAnswer extends StorePairQuestion {
  verdict: "same" | "different" | "undetermined";
  confidence: number | null;
  merchant: string | null;
  reason: string | null;
}

export function buildStoreMatchPrompt(
  pairs: StorePairQuestion[],
  examples: TaughtExample[]
): string {
  const exampleText =
    examples.length > 0
      ? examples
          .map(
            (e) =>
              `- カード「${e.cardName}」とレシート「${e.receiptName}」は${
                e.verdict === "same" ? "同じ店" : "別の店"
              }${e.note ? `（${e.note}）` : ""}`
          )
          .join("\n")
      : "（まだありません）";
  const pairText = pairs
    .map((p, i) => `${i + 1}. カード明細「${p.cardName}」／ レシート「${p.receiptName}」`)
    .join("\n");

  return `あなたは家計簿アプリで、クレジットカード明細とレシートを突き合わせるアシスタントです。
次の各組について、カード明細の加盟店名（決済代行名・運営会社名・ローマ字やカナの略記を含む）が、レシートの店と同じ店での支払いかを判定してください。
金額はすでに一致しています。店名の文字が似ているかではなく、実際に同じ店（同じ会計）と言えるかで判断してください。

【進め方】
- 加盟店名が何の店か分からない場合は、Web 検索で「その決済名がどの店・どの会社か」を調べてから判断する
- 運営会社名（例: イオンリテール → イオンスタイル等）、英字とカナ（例: Big-A とビッグ・エー）、決済手段の付記（例: ／NFC）は同じ店として扱ってよい
- レシートの店名は画像の文字認識（OCR）結果のため、支店名の漢字が誤読されていることがある（例: 鳩ヶ谷 → 丸鳥ヶ谷・九鴻ヶ谷・丸鷹ヶ谷）。チェーンが同じで、支店名の違いが誤読で説明できる場合は同じ店
- レシートに支店名が無い場合は、チェーンが同じなら同じ店とみなしてよい（金額が一致しているため）
- 同じ商業施設に入っている別の店（例: イオンモール内のセリア）や、地名だけが共通する別の店は「別の店」
- 調べても確信が持てない場合は無理に決めず undetermined にする

【ユーザーが過去に教えた判定（最優先の判断材料）】
${exampleText}

【判定する組】
${pairText}

最後に、次の JSON 配列だけを出力してください（説明文不要）。
[
  { "index": 1, "verdict": "same | different | undetermined", "confidence": 0.0〜1.0, "merchant": "カード明細の実際の店・会社名（分からなければ null）", "reason": "判断理由を短く" }
]`;
}

export function parseStoreMatchAnswer(
  text: string,
  pairs: StorePairQuestion[]
): StorePairAnswer[] {
  const undetermined = (p: StorePairQuestion, reason: string): StorePairAnswer => ({
    ...p,
    verdict: "undetermined",
    confidence: null,
    merchant: null,
    reason,
  });

  const match = text.match(/\[[\s\S]*\]/);
  let parsed: unknown = null;
  try {
    parsed = match ? JSON.parse(match[0]) : null;
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    return pairs.map((p) => undetermined(p, "AIの回答を読み取れませんでした"));
  }

  return pairs.map((p, i) => {
    const row = parsed.find(
      (r): r is Record<string, unknown> =>
        !!r && typeof r === "object" && Number((r as { index?: unknown }).index) === i + 1
    );
    if (!row) return undetermined(p, "AIの回答にこの組がありませんでした");

    const confidence = typeof row.confidence === "number" ? row.confidence : null;
    const raw = row.verdict;
    const confident = confidence !== null && confidence >= AI_MIN_CONFIDENCE;
    const verdict =
      (raw === "same" || raw === "different") && confident ? raw : "undetermined";
    return {
      ...p,
      verdict,
      confidence,
      merchant: typeof row.merchant === "string" ? row.merchant : null,
      reason: typeof row.reason === "string" ? row.reason : null,
    };
  });
}

async function askOnce(
  pairs: StorePairQuestion[],
  examples: TaughtExample[]
): Promise<StorePairAnswer[]> {
  const tools: Anthropic.Messages.ToolUnion[] = [
    { type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES_PER_REQUEST },
  ];
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: buildStoreMatchPrompt(pairs, examples) },
  ];

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools,
    messages,
  });
  for (let i = 0; i < MAX_CONTINUATIONS && response.stop_reason === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      tools,
      messages,
    });
  }

  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseStoreMatchAnswer(text, pairs);
}

/**
 * 店名の組を判定する。API エラーの組は判定不可（理由つき）で返し、例外は投げない。
 */
export async function judgeStorePairsWithAi(
  pairs: StorePairQuestion[],
  examples: TaughtExample[]
): Promise<StorePairAnswer[]> {
  const results: StorePairAnswer[] = [];
  for (let i = 0; i < pairs.length; i += PAIRS_PER_REQUEST) {
    const chunk = pairs.slice(i, i + PAIRS_PER_REQUEST);
    try {
      results.push(...(await askOnce(chunk, examples)));
    } catch (error) {
      console.error("[store-match-ai] failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      results.push(
        ...chunk.map((p) => ({
          ...p,
          verdict: "undetermined" as const,
          confidence: null,
          merchant: null,
          reason: `AI判定エラー: ${message.slice(0, 200)}`,
        }))
      );
    }
  }
  return results;
}
