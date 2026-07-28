import { NextRequest, NextResponse } from "next/server";
import { extractTransactionsFromImage } from "@/lib/classifiers";

/**
 * 利用明細画像をアップロードして取引リストを抽出するエンドポイント。
 * 1リクエストにつき1画像。複数画像はクライアント側で順次呼び出す（レート制限対策）。
 * 実際の保存は /api/import/confirm に委ねる（確認画面を挟む）。
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "ファイルがありません" }, { status: 400 });
    }

    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    // 一部端末では type が空になることがあるため、拡張子でも判定
    const extOk = /\.(jpe?g|png|gif|webp)$/i.test(file.name);
    if (file.type && !validTypes.includes(file.type) && !extOk) {
      return NextResponse.json(
        { error: `「${file.name}」は対応フォーマットではありません（JPEG, PNG, GIF, WebP）` },
        { status: 400 }
      );
    }

    const mediaType = (
      validTypes.includes(file.type)
        ? file.type
        : file.name.toLowerCase().endsWith(".png")
          ? "image/png"
          : file.name.toLowerCase().endsWith(".webp")
            ? "image/webp"
            : file.name.toLowerCase().endsWith(".gif")
              ? "image/gif"
              : "image/jpeg"
    ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

    const buffer = await file.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const extracted = await extractTransactionsFromImage(base64, mediaType);
    const raw = extracted.map((tx) => ({
      date: tx.date,
      description: tx.description,
      amount: Math.round(tx.amount),
      source: "IMAGE" as const,
    }));

    const { classifyParsedTransactions } = await import("@/lib/classify-pipeline");
    const transactions = await classifyParsedTransactions(raw, { autoClassify: true });

    return NextResponse.json({
      fileName: file.name,
      transactions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "画像の解析に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
