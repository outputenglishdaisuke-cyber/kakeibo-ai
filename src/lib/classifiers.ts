import { anthropic, MODEL } from "@/lib/anthropic";
import type { Category, ClassificationResult, ParsedTransaction } from "@/types";

/**
 * CSV のヘッダーとサンプル行から、日付・利用先・金額に対応する列名を AI に推定させる。
 */
export async function inferCsvColumnMapping(
  csvSample: string
): Promise<{ date: string; description: string; amount: string }> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `以下はクレジットカード利用明細 CSV のヘッダーと最初の数行です。
日付・利用先(店舗名)・金額(円)に相当する列名をそれぞれ特定し、JSON 形式で返してください。

CSV サンプル:
\`\`\`
${csvSample}
\`\`\`

レスポンスは以下の JSON のみを返してください（説明文不要）:
{"date": "<列名>", "description": "<列名>", "amount": "<列名>"}`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = text.match(/\{[^}]+\}/);
  if (!jsonMatch) {
    throw new Error("AI が列マッピングを返しませんでした: " + text);
  }
  return JSON.parse(jsonMatch[0]);
}

/**
 * 複数の取引を一括で AI 分類する。
 * categories を毎回渡すことで、新しいカテゴリに追従できる。
 */
export async function classifyTransactions(
  transactions: { description: string; amount: number }[],
  categories: Category[]
): Promise<ClassificationResult[]> {
  if (transactions.length === 0) return [];

  const categoryList = categories
    .map((c) => `- ${c.name} (id: ${c.id})`)
    .join("\n");

  const txList = transactions
    .map((t, i) => `${i + 1}. ${t.description} (${t.amount}円)`)
    .join("\n");

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `あなたは家計簿の支出分類アシスタントです。
以下の支出項目を、指定されたカテゴリに分類してください。

【カテゴリ一覧】
${categoryList}

【分類する支出】
${txList}

各支出について、最も適切なカテゴリを選択し、以下の JSON 配列形式で返してください。
カテゴリが該当しない場合は categoryId を null にしてください。
確信度は 0.0〜1.0 で表してください。

[
  {
    "index": 1,
    "suggestedCategoryId": "<id または null>",
    "suggestedCategoryName": "<カテゴリ名>",
    "confidence": 0.9
  },
  ...
]

JSON 配列のみを返してください（説明文不要）。`,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "[]";

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const parsed: {
    index: number;
    suggestedCategoryId: string | null;
    suggestedCategoryName: string;
    confidence: number;
  }[] = JSON.parse(arrayMatch[0]);

  return parsed.map((item) => ({
    description: transactions[item.index - 1]?.description ?? "",
    suggestedCategoryId: item.suggestedCategoryId ?? undefined,
    suggestedCategoryName: item.suggestedCategoryName,
    confidence: item.confidence,
  }));
}

/**
 * 利用明細画像から取引情報をOCRで抽出する（Claude Vision）。
 */
export async function extractTransactionsFromImage(
  base64Image: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
): Promise<{ date: string; description: string; amount: number }[]> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mediaType,
              data: base64Image,
            },
          },
          {
            type: "text",
            text: `この画像はクレジットカードや銀行の利用明細です。
画像から取引情報を読み取り、以下の JSON 配列形式で返してください。
日付は YYYY-MM-DD 形式、金額は円単位の整数で返してください。

[
  {
    "date": "2024-01-15",
    "description": "利用先名",
    "amount": 1500
  },
  ...
]

JSON 配列のみを返してください（説明文不要）。`,
          },
        ],
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "[]";
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  return JSON.parse(arrayMatch[0]);
}
