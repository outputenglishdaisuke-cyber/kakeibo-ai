import Papa from "papaparse";
import type { CsvRow, ParsedTransaction, CsvColumnMapping } from "@/types";

/**
 * CSV 文字列をパースして行の配列を返す。
 */
export function parseCsvString(csvText: string): {
  headers: string[];
  rows: CsvRow[];
} {
  const result = Papa.parse<CsvRow>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const headers = result.meta.fields ?? [];
  return { headers, rows: result.data };
}

/**
 * カラムマッピングを使って CsvRow[] → ParsedTransaction[] に変換する。
 * 金額はカンマ・円記号・スペースを除去してから数値化。
 * 入力がマイナスの場合は絶対値を使用（支出として扱う）。
 */
export function mapRowsToTransactions(
  rows: CsvRow[],
  mapping: CsvColumnMapping
): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];

  for (const row of rows) {
    const rawDate = row[mapping.date]?.trim();
    const rawDesc = row[mapping.description]?.trim();
    const rawAmount = row[mapping.amount]?.trim();

    if (!rawDate || !rawDesc || !rawAmount) continue;

    const cleanedAmount = rawAmount.replace(/[¥,\s円]/g, "");
    const amount = Math.abs(parseFloat(cleanedAmount));

    if (isNaN(amount) || amount === 0) continue;

    transactions.push({
      date: rawDate,
      description: rawDesc,
      amount: Math.round(amount),
      source: "CSV",
    });
  }

  return transactions;
}

/**
 * CSV の最初の数行サンプルを文字列として返す（AI プロンプト用）。
 */
export function getCsvSample(
  headers: string[],
  rows: CsvRow[],
  sampleCount = 3
): string {
  const sample = rows.slice(0, sampleCount);
  const lines = [headers.join(",")];
  for (const row of sample) {
    lines.push(headers.map((h) => row[h] ?? "").join(","));
  }
  return lines.join("\n");
}
