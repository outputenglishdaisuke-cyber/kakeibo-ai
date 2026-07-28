import { NextRequest, NextResponse } from "next/server";
import { extractTransactionsFromImage } from "@/lib/classifiers";
import { ensureDefaultCategories } from "@/lib/default-categories";
import type { ParsedTransaction } from "@/types";

/**
 * レシート／利用明細画像をアップロードして取引リストを抽出する。
 * 1リクエストにつき1画像。複数画像はクライアント側で順次呼び出す。
 * レシートで品目が読める場合は品目ごとに分割し、カテゴリも Vision 側で提案する。
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "ファイルがありません" }, { status: 400 });
    }

    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const extOk = /\.(jpe?g|png|gif|webp)$/i.test(file.name);
    if (file.type && !validTypes.includes(file.type) && !extOk) {
      return NextResponse.json(
        {
          error: `「${file.name}」は対応フォーマットではありません（JPEG, PNG, GIF, WebP）`,
        },
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

    const categories = await ensureDefaultCategories();
    const nameToCategory = new Map(categories.map((c) => [c.name, c]));

    const extracted = await extractTransactionsFromImage(
      base64,
      mediaType,
      categories.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
        description: c.description,
        icon: c.icon,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }))
    );

    if (extracted.length === 0) {
      return NextResponse.json({
        fileName: file.name,
        transactions: [],
      });
    }

    const receiptGroupId = `receipt-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const raw: ParsedTransaction[] = extracted.map((tx) => {
      const cat = tx.categoryName ? nameToCategory.get(tx.categoryName) : null;
      return {
        date: tx.date,
        description: tx.description,
        amount: Math.round(tx.amount),
        source: "IMAGE" as const,
        categoryId: cat?.id ?? null,
        categoryName: cat?.name ?? null,
        categoryColor: cat?.color ?? null,
        receiptGroupId,
        storeName: tx.storeName ?? null,
        itemName: tx.itemName ?? null,
      };
    });

    const { classifyParsedTransactions } = await import(
      "@/lib/classify-pipeline"
    );
    const transactions = await classifyParsedTransactions(raw, {
      autoClassify: true,
    });

    return NextResponse.json({
      fileName: file.name,
      receiptGroupId,
      transactions,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "画像の解析に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
