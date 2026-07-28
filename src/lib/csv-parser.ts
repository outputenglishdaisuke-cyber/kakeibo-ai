import Papa from "papaparse";
import type { CsvRow, ParsedTransaction, CsvColumnMapping } from "@/types";

const DATE_LIKE =
  /^\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}/;

/**
 * 先頭行がヘッダーではなくデータ行かどうかを判定する。
 * カード会社明細（日付が1列目から始まる）などヘッダーなし CSV 向け。
 */
function looksLikeDataRow(firstCells: string[]): boolean {
  const first = (firstCells[0] ?? "").trim();
  if (!first) return false;
  return DATE_LIKE.test(first);
}

/**
 * CSV 文字列をパースして行の配列を返す。
 * ヘッダーなしの場合は「列1」「列2」… の合成ヘッダーを付与する。
 */
export function parseCsvString(csvText: string): {
  headers: string[];
  rows: CsvRow[];
  hasHeader: boolean;
} {
  const preview = Papa.parse<string[]>(csvText, {
    header: false,
    skipEmptyLines: true,
    preview: 1,
  });
  const firstRow = preview.data[0] ?? [];
  const hasHeader = firstRow.length > 0 && !looksLikeDataRow(firstRow);

  if (hasHeader) {
    const result = Papa.parse<CsvRow>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });
    const headers = (result.meta.fields ?? []).map((h) => h.trim()).filter(Boolean);
    return { headers, rows: result.data, hasHeader: true };
  }

  // ヘッダーなし: 全行を配列として読み、合成ヘッダーでオブジェクト化
  const result = Papa.parse<string[]>(csvText, {
    header: false,
    skipEmptyLines: true,
  });
  const maxCols = result.data.reduce((m, row) => Math.max(m, row.length), 0);
  const headers = Array.from({ length: maxCols }, (_, i) => `列${i + 1}`);
  const rows: CsvRow[] = result.data.map((cells) => {
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });

  return { headers, rows, hasHeader: false };
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
  sampleCount = 3,
  hasHeader = true
): string {
  const sample = rows.slice(0, sampleCount);
  const lines = [
    hasHeader
      ? headers.join(",")
      : `# ヘッダーなしCSV（合成列名）: ${headers.join(",")}`,
  ];
  for (const row of sample) {
    lines.push(headers.map((h) => row[h] ?? "").join(","));
  }
  return lines.join("\n");
}
