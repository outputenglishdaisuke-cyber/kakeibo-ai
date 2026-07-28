import Papa from "papaparse";
import type { CsvStructureAnalysis, ParsedTransaction } from "@/types";

/**
 * CSV テキストを行×列の二次元配列にパースする（ヘッダー判定なし）。
 * 空行はスキップする。
 */
export function parseCsvToMatrix(csvText: string): string[][] {
  const result = Papa.parse<string[]>(csvText, {
    header: false,
    skipEmptyLines: true,
  });
  return result.data.map((row) => row.map((cell) => (cell ?? "").trim()));
}

/**
 * Claude に渡す先頭サンプル（行番号付き）。
 */
export function buildCsvSampleForAi(matrix: string[][], maxRows = 15): string {
  const lines = matrix.slice(0, maxRows).map((row, i) => {
    const cells = row.map((c) => JSON.stringify(c)).join(", ");
    return `row[${i}]: [${cells}]`;
  });
  return [
    `総サンプル行数: ${Math.min(matrix.length, maxRows)} / 全体行数: ${matrix.length}`,
    `最大列数: ${matrix.reduce((m, r) => Math.max(m, r.length), 0)}`,
    "",
    ...lines,
  ].join("\n");
}

const FULLWIDTH_DIGIT_MAP: Record<string, string> = {
  "０": "0",
  "１": "1",
  "２": "2",
  "３": "3",
  "４": "4",
  "５": "5",
  "６": "6",
  "７": "7",
  "８": "8",
  "９": "9",
};

/** 全角英数字・記号を半角に寄せる */
export function toHalfWidth(text: string): string {
  return text
    .replace(/[０-９]/g, (ch) => FULLWIDTH_DIGIT_MAP[ch] ?? ch)
    .replace(/[Ａ-Ｚａ-ｚ]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/　/g, " ")
    .replace(/[−－]/g, "-")
    .replace(/￥/g, "¥");
}

/**
 * 金額文字列を整数に変換する。
 * 全角数字・カンマ・円記号を除去し、マイナス（返品）は符号を保持する。
 */
export function parseAmount(raw: string): number | null {
  if (!raw?.trim()) return null;
  let s = toHalfWidth(raw.trim());
  s = s.replace(/[¥￥円,\s]/g, "");
  // 末尾の ▲ や (123) 形式
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-") || s.startsWith("▲") || s.startsWith("△")) {
    negative = true;
    s = s.replace(/^[-▲△]+/, "");
  }
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  const value = Math.round(parseFloat(s));
  if (isNaN(value) || value === 0) return null;
  return negative ? -value : value;
}

/**
 * 日付文字列を YYYY-MM-DD に正規化する。失敗時は null。
 */
export function normalizeDate(raw: string, _dateFormatHint?: string): string | null {
  if (!raw?.trim()) return null;
  let s = toHalfWidth(raw.trim());
  s = s.replace(/年|月/g, "/").replace(/日/g, "");

  // YYYY/M/D or YYYY-M-D
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = m[1];
    const mo = m[2].padStart(2, "0");
    const d = m[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  // YY/M/D
  m = s.match(/^(\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const yy = parseInt(m[1], 10);
    const y = yy >= 70 ? `19${m[1]}` : `20${m[1]}`;
    const mo = m[2].padStart(2, "0");
    const d = m[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }

  return null;
}

/**
 * AI の構造解析結果をもとに、全行を取引リストへ変換する。
 */
export function mapMatrixToTransactions(
  matrix: string[][],
  structure: CsvStructureAnalysis
): ParsedTransaction[] {
  const {
    dataStartRow,
    dateColumnIndex,
    storeColumnIndex,
    amountColumnIndex,
    dateFormat,
    skipRowIndices,
  } = structure;

  const skip = new Set(skipRowIndices ?? []);
  const transactions: ParsedTransaction[] = [];

  for (let i = dataStartRow; i < matrix.length; i++) {
    if (skip.has(i)) continue;
    // ヘッダー行はデータに含めない
    if (structure.hasHeader && structure.headerRowIndex === i) continue;

    const row = matrix[i];
    if (!row || row.every((c) => !c)) continue;

    const rawDate = row[dateColumnIndex] ?? "";
    const rawStore = row[storeColumnIndex] ?? "";
    const rawAmount = row[amountColumnIndex] ?? "";

    const date = normalizeDate(rawDate, dateFormat);
    const description = toHalfWidth(rawStore).trim();
    const amount = parseAmount(rawAmount);

    if (!date || !description || amount === null) continue;

    transactions.push({
      date,
      description,
      amount,
      source: "CSV",
    });
  }

  return transactions;
}
