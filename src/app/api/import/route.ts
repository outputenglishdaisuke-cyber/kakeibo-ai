import { NextRequest, NextResponse } from "next/server";
import {
  parseCsvToMatrix,
  buildCsvSampleForAi,
  mapMatrixToTransactions,
} from "@/lib/csv-parser";
import { decodeCsvBuffer, CsvEncodingError } from "@/lib/csv-encoding";
import { analyzeCsvStructure } from "@/lib/classifiers";

const STRUCTURE_ERROR =
  "このCSVの構造を自動認識できませんでした。手入力または別の形式でお試しください";

/**
 * CSV を受け取り、Claude で構造解析したうえで取引リストを返す。
 * 1リクエストにつき1ファイル。DB保存は /api/import/confirm。
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "ファイルがありません" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let csvText: string;
    let encoding: string;
    try {
      const decoded = decodeCsvBuffer(buffer);
      csvText = decoded.text;
      encoding = decoded.encoding;
    } catch (err) {
      if (err instanceof CsvEncodingError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      return NextResponse.json(
        { error: "文字コードを認識できませんでした" },
        { status: 400 }
      );
    }

    const matrix = parseCsvToMatrix(csvText);
    if (matrix.length === 0) {
      return NextResponse.json(
        { error: `「${file.name}」にデータがありません` },
        { status: 400 }
      );
    }

    // 先頭15行だけを Claude に渡し、構造を判定させる
    const sample = buildCsvSampleForAi(matrix, 15);
    const structure = await analyzeCsvStructure(sample);

    const indicesInvalid =
      structure.dateColumnIndex < 0 ||
      structure.storeColumnIndex < 0 ||
      structure.amountColumnIndex < 0;

    if (
      structure.unrecognized ||
      !structure.isCsv ||
      structure.confidence === "low" ||
      indicesInvalid
    ) {
      return NextResponse.json(
        {
          error: STRUCTURE_ERROR,
          structure,
          encoding,
        },
        { status: 422 }
      );
    }

    const transactions = mapMatrixToTransactions(matrix, structure);

    if (transactions.length === 0) {
      return NextResponse.json(
        {
          error: STRUCTURE_ERROR,
          structure,
          encoding,
          detail: "構造は判定できましたが、取引行を抽出できませんでした",
        },
        { status: 422 }
      );
    }

    return NextResponse.json({
      fileName: file.name,
      encoding,
      structure,
      transactions,
      totalRows: matrix.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "CSV の解析に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
