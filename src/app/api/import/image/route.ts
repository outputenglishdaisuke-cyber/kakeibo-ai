import { NextRequest, NextResponse } from "next/server";
import { extractTransactionsFromImage } from "@/lib/classifiers";

/**
 * 利用明細画像をアップロードして取引リストを抽出するエンドポイント。
 * 実際の保存は /api/import/confirm に委ねる（確認画面を挟む）。
 */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "ファイルがありません" }, { status: 400 });
  }

  const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!validTypes.includes(file.type)) {
    return NextResponse.json(
      { error: "対応フォーマット: JPEG, PNG, GIF, WebP" },
      { status: 400 }
    );
  }

  const buffer = await file.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  const transactions = await extractTransactionsFromImage(
    base64,
    file.type as "image/jpeg" | "image/png" | "image/gif" | "image/webp"
  );

  return NextResponse.json({ transactions });
}
