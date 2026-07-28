import { NextRequest, NextResponse } from "next/server";
import { parseCsvString, mapRowsToTransactions, getCsvSample } from "@/lib/csv-parser";
import { inferCsvColumnMapping } from "@/lib/classifiers";

/**
 * CSV テキストを受け取り、列推定と解析済み取引リストを返すエンドポイント。
 * 1リクエストにつき1ファイル。複数ファイルはクライアント側で順次呼び出す。
 * 実際のDB保存は /api/import/confirm で行う（確認画面を挟むため）。
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "ファイルがありません" }, { status: 400 });
    }

    const csvText = await file.text();
    const { headers, rows } = parseCsvString(csvText);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: `「${file.name}」にデータがありません` },
        { status: 400 }
      );
    }

    const sample = getCsvSample(headers, rows, 3);
    const mapping = await inferCsvColumnMapping(sample);
    const transactions = mapRowsToTransactions(rows, mapping);

    return NextResponse.json({
      fileName: file.name,
      headers,
      mapping,
      transactions,
      totalRows: rows.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "CSV の解析に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
