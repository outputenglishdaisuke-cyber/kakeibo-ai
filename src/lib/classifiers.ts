import { anthropic, MODEL } from "@/lib/anthropic";
import type {
  Category,
  ClassificationResult,
  CsvStructureAnalysis,
  ExtractedImageTransaction,
} from "@/types";

/**
 * CSV 先頭サンプルから構造を Claude に解析させる。
 * 決め打ちのパターンマッチではなく、AI による構造理解を中心にする。
 */
export async function analyzeCsvStructure(
  csvSample: string
): Promise<CsvStructureAnalysis> {
  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `あなたはクレジットカード・銀行の利用明細 CSV の構造解析アシスタントです。
以下はアップロードされたファイルの先頭数行です（row[n] は 0 始まりの行番号、各要素は列の値です）。

このサンプルだけを見て、ファイル構造を判定し、指定の JSON のみを返してください。

【必ず判定すること】
1. 本当にCSV形式の利用明細データか（氏名・カード番号だけの情報行が混ざっていないか）
2. ヘッダー行があるか。ある場合その行番号（0始まり）
3. 実際のデータ行が何行目から始まるか（dataStartRow, 0始まり）
4. 各列インデックス（0始まり）が「日付」「店名・利用先」「金額」「その他」のどれか
   - dateColumnIndex / storeColumnIndex / amountColumnIndex を特定する
   - 金額列が複数ある場合は「利用金額・請求金額」として最も適切な1列を選ぶ（回数や支払回数の列は選ばない）
5. 日付フォーマット（例: YYYY/MM/DD, YYYY/M/D, 全角数字の有無）
6. 金額フォーマット（半角/全角、カンマ、マイナス・返品の表現）
7. データではない行（情報行など）があれば skipRowIndices に列挙する
8. 構造に自信が持てない場合は unrecognized: true, confidence: "low" とし、無理に列を当てない

【出力JSONスキーマ】（これ以外の文字は出力しない）
{
  "isCsv": true,
  "confidence": "high" | "medium" | "low",
  "unrecognized": false,
  "hasHeader": false,
  "headerRowIndex": null,
  "dataStartRow": 0,
  "dateColumnIndex": 0,
  "storeColumnIndex": 1,
  "amountColumnIndex": 2,
  "dateFormat": "YYYY/M/D",
  "amountFormat": "半角数字。マイナスは先頭に-。全角数字の場合あり",
  "skipRowIndices": [],
  "notes": "短い日本語の補足"
}

構造を認識できない場合の例:
{
  "isCsv": false,
  "confidence": "low",
  "unrecognized": true,
  "hasHeader": false,
  "headerRowIndex": null,
  "dataStartRow": 0,
  "dateColumnIndex": -1,
  "storeColumnIndex": -1,
  "amountColumnIndex": -1,
  "dateFormat": "",
  "amountFormat": "",
  "skipRowIndices": [],
  "notes": "理由"
}

CSV サンプル:
\`\`\`
${csvSample}
\`\`\``,
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      isCsv: false,
      confidence: "low",
      unrecognized: true,
      hasHeader: false,
      headerRowIndex: null,
      dataStartRow: 0,
      dateColumnIndex: -1,
      storeColumnIndex: -1,
      amountColumnIndex: -1,
      dateFormat: "",
      amountFormat: "",
      skipRowIndices: [],
      notes: "AI が構造JSONを返しませんでした",
    };
  }

  const parsed = JSON.parse(jsonMatch[0]) as Partial<CsvStructureAnalysis>;

  const confidence =
    parsed.confidence === "high" ||
    parsed.confidence === "medium" ||
    parsed.confidence === "low"
      ? parsed.confidence
      : "low";

  return {
    isCsv: Boolean(parsed.isCsv),
    confidence,
    unrecognized: Boolean(parsed.unrecognized) || confidence === "low",
    hasHeader: Boolean(parsed.hasHeader),
    headerRowIndex:
      typeof parsed.headerRowIndex === "number" ? parsed.headerRowIndex : null,
    dataStartRow:
      typeof parsed.dataStartRow === "number" && parsed.dataStartRow >= 0
        ? parsed.dataStartRow
        : 0,
    dateColumnIndex:
      typeof parsed.dateColumnIndex === "number" ? parsed.dateColumnIndex : -1,
    storeColumnIndex:
      typeof parsed.storeColumnIndex === "number"
        ? parsed.storeColumnIndex
        : -1,
    amountColumnIndex:
      typeof parsed.amountColumnIndex === "number"
        ? parsed.amountColumnIndex
        : -1,
    dateFormat: String(parsed.dateFormat ?? ""),
    amountFormat: String(parsed.amountFormat ?? ""),
    skipRowIndices: Array.isArray(parsed.skipRowIndices)
      ? parsed.skipRowIndices.filter((n): n is number => typeof n === "number")
      : [],
    notes: String(parsed.notes ?? ""),
  };
}

/**
 * 複数の取引を一括で AI 分類する。
 * 店名から主な取扱を推測し、カテゴリ説明を含む候補から1つ選ばせる。
 */
export async function classifyTransactions(
  transactions: { description: string; amount: number }[],
  categories: Category[]
): Promise<ClassificationResult[]> {
  if (transactions.length === 0) return [];
  if (categories.length === 0) return [];

  const categoryList = categories
    .map(
      (c) =>
        `- 名前: ${c.name} / id: ${c.id}` +
        (c.description ? ` / 説明: ${c.description}` : "")
    )
    .join("\n");

  const nameToId = new Map(categories.map((c) => [c.name, c.id]));
  const idSet = new Set(categories.map((c) => c.id));

  const txList = transactions
    .map((t, i) => `${i + 1}. 店名「${t.description}」（金額: ${t.amount}円）`)
    .join("\n");

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `あなたは家計簿の支出分類アシスタントです。
利用明細には「店名（加盟店名）」しかなく、購入した具体的な商品は分かりません。
そのため、店名から「その店が主にどのようなものを取り扱っているか」を一般的な知識で推測し、最も可能性の高いカテゴリを1つ選んでください。

【分類の基本方針】
- スーパー（イオン、ライフ、西友、業務スーパー、ビッグ・エー、ジェーソン等）→ 食費
- コンビニ（セブンイレブン、ファミリーマート、ローソン等）→ 食費（迷ったら食費）
- ドラッグストア（マツモトキヨシ、ウエルシア、ウェルパーク、クスリのナカヤマ等）→ 日用品
- 100円ショップ（ダイソー、セリア等）→ 日用品（迷ったら日用品）
- 飲食店・カフェ・ファストフード（すき家、スターバックス等）→ 外食費
- 家具・家電量販・ホームセンター（ニトリ、コジマ、ヤマダ電機、IKEA、テックランド等）→ 特別費
- 電力会社（東京電力、関西電力等）→ 電気
- ガス会社（東京ガス等）→ ガス
- 水道局 → 水道
- 不動産・家賃引き落とし → 家賃
- 動画/音楽配信、書店、ゲーム（Netflix、Kindle、Steam、NINTENDO、Jリーグチケット等）→ 趣味・嗜好・娯楽
- 無印良品は日用品寄り（迷ったら日用品）
- 判断がどうしてもつかない場合のみ suggestedCategoryId / suggestedCategoryName を null にする
- 「未分類」「unidentified」というカテゴリ名は使わない（候補に無い）
- 安易に null にせず、一般知識で妥当なら必ずいずれかのカテゴリを選ぶ

【カテゴリ一覧（この中からのみ選択）】
${categoryList}

【分類する支出】
${txList}

各支出について、以下の JSON 配列のみを返してください（説明文不要）。
suggestedCategoryId には上記の id を正確にコピーしてください。名前だけの場合は suggestedCategoryName にカテゴリ名を入れてください。

[
  {
    "index": 1,
    "suggestedCategoryId": "<id または null>",
    "suggestedCategoryName": "<カテゴリ名 または null>",
    "confidence": 0.9
  }
]`,
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
    suggestedCategoryName: string | null;
    confidence: number;
  }[] = JSON.parse(arrayMatch[0]);

  return parsed.map((item) => {
    let id =
      item.suggestedCategoryId && idSet.has(item.suggestedCategoryId)
        ? item.suggestedCategoryId
        : null;
    const name = item.suggestedCategoryName?.trim() || "";

    // 「unidentified」「未分類」は無視
    const invalidName =
      !name ||
      name.toLowerCase() === "unidentified" ||
      name === "未分類" ||
      name.toLowerCase() === "null";

    if (!id && !invalidName && nameToId.has(name)) {
      id = nameToId.get(name)!;
    }

    return {
      description: transactions[item.index - 1]?.description ?? "",
      suggestedCategoryId: id ?? undefined,
      suggestedCategoryName: id
        ? (categories.find((c) => c.id === id)?.name ?? name)
        : "",
      confidence: item.confidence ?? 0,
    };
  });
}

/**
 * 利用明細画像・レシート画像から取引情報をOCRで抽出する（Claude Vision）。
 * レシートで品目内訳が読める場合は品目ごとに分割し、カテゴリ名も提案する。
 * 読めない場合は店名ベースの1件にフォールバックする。
 */
export async function extractTransactionsFromImage(
  base64Image: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  categories: Category[] = []
): Promise<ExtractedImageTransaction[]> {
  const categoryNames = categories.map((c) => c.name);
  const categoryListText =
    categoryNames.length > 0
      ? categoryNames.map((n) => `- ${n}`).join("\n")
      : `- 家賃
- 電気
- ガス
- 水道
- 食費
- 日用品
- 外食費
- 趣味・嗜好・娯楽
- 特別費`;

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8192,
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
            text: `これは家計簿アプリのレシート・利用明細解析機能です。
画像を読み取り、支出明細を可能な限り正確に抽出してください。

【あなたの役割】
- レシートに記載された個々の購入品目を可能な限り読み取り、それぞれの金額を抽出すること
- 各品目について、次のカテゴリのいずれに該当するかを判定すること
- 判定が難しい場合は、無理に分類せず categoryName を null（未分類）としてよいこと
- レシートの品目内訳が読み取れない場合（感熱紙の劣化、手書き、合計金額のみの記載など）は、店名全体から推測した1件の明細として処理してよいこと

【カテゴリ一覧（categoryName はこの名前からのみ選ぶ。該当なしは null）】
${categoryListText}

【画像の種類と抽出方針】
1. スーパー・コンビニ等のレシートで品目と金額が読める場合
   - 各購入品目を1件ずつ出力する
   - storeName は店名、itemName は商品名、description は「店名 / 商品名」
   - 税・ポイント・値引・小計・合計行は品目に含めない（値引行は負の amount でも可だが、合計行は出さない）
   - 例: 牛乳・食パン → 食費、洗剤・ティッシュ → 日用品、弁当・総菜で外食寄りのものは外食費でも可（迷ったら食費）
2. 品目内訳が読めず合計金額しか分からない場合
   - itemsReadable 相当として 1件だけ返す
   - description / storeName に店名、itemName は null、amount は合計金額
   - 店名からカテゴリを推測（例: 飲食店 → 外食費、スーパー → 食費）
3. クレジットカード／銀行の利用明細画像の場合
   - 各利用行を1件ずつ返す（storeName は加盟店名、itemName は null）
   - description は加盟店名

【出力形式】JSON 配列のみ（説明文不要）:
[
  {
    "date": "YYYY-MM-DD",
    "storeName": "店名",
    "itemName": "品目名またはnull",
    "description": "表示用の説明（店名 / 品目 または 店名）",
    "amount": 1500,
    "categoryName": "食費"
  }
]

制約:
- date は YYYY-MM-DD。不明なら今日の日付ではなく、画像から読める最も確からしい日付。完全不明なら null ではなく画像内の他の手がかりから推定し、どうしても無理なら省略せず空文字 "" ではなく可能な限り埋める
- amount は円単位の整数（正の購入額）
- categoryName が候補に無い場合は null
- JSON 配列のみを返す`,
          },
        ],
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "[]";
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  const parsed: unknown = JSON.parse(arrayMatch[0]);
  if (!Array.isArray(parsed)) return [];

  const nameSet = new Set(categoryNames);

  return parsed
    .map((raw): ExtractedImageTransaction | null => {
      if (!raw || typeof raw !== "object") return null;
      const row = raw as Record<string, unknown>;
      const amount = Math.round(Number(row.amount));
      if (!Number.isFinite(amount) || amount === 0) return null;

      const storeName =
        typeof row.storeName === "string" && row.storeName.trim()
          ? row.storeName.trim()
          : null;
      const itemName =
        typeof row.itemName === "string" && row.itemName.trim()
          ? row.itemName.trim()
          : null;
      let description =
        typeof row.description === "string" ? row.description.trim() : "";
      if (!description) {
        description =
          storeName && itemName
            ? `${storeName} / ${itemName}`
            : storeName || itemName || "不明な支出";
      }

      const dateRaw = typeof row.date === "string" ? row.date.trim() : "";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
        ? dateRaw
        : new Date().toISOString().slice(0, 10);

      let categoryName: string | null =
        typeof row.categoryName === "string" ? row.categoryName.trim() : null;
      if (
        !categoryName ||
        categoryName === "未分類" ||
        categoryName.toLowerCase() === "null" ||
        categoryName.toLowerCase() === "unidentified"
      ) {
        categoryName = null;
      } else if (nameSet.size > 0 && !nameSet.has(categoryName)) {
        // 表記ゆれの簡易吸収
        const fuzzy = [...nameSet].find(
          (n) =>
            n.replace(/[・\s]/g, "") === categoryName!.replace(/[・\s]/g, "")
        );
        categoryName = fuzzy ?? null;
      }

      return {
        date,
        description,
        amount,
        storeName,
        itemName,
        categoryName,
      };
    })
    .filter((x): x is ExtractedImageTransaction => x !== null);
}

