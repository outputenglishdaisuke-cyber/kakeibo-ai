import { NextRequest, NextResponse } from "next/server";
import { parseCsvString, mapRowsToTransactions, getCsvSample } from "@/lib/csv-parser";
import { inferCsvColumnMapping } from "@/lib/classifiers";

/**
 * CSV テキストを受け取り、列推定と解析済み取引リストを返すエンドポイント。
 * 実際のDB保存は /api/import/confirm で行う（確認画面を挟むため）。
 */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "ファイルがありません" }, { status: 400 });
  }

  const csvText = await file.text();
  const { headers, rows } = parseCsvString(csvText);

  if (rows.length === 0) {
    return NextResponse.json({ error: "CSV にデータがありません" }, { status: 400 });
  }

  // AI に列マッピングを推定させる
  const sample = getCsvSample(headers, rows, 3);
  const mapping = await inferCsvColumnMapping(sample);

  // 推定されたマッピングで取引をパース
  const transactions = mapRowsToTransactions(rows, mapping);

  return NextResponse.json({
    headers,
    mapping,
    transactions,
    totalRows: rows.length,
  });
}
