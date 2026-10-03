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

function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * 日付文字列を YYYY-MM-DD に正規化する。失敗時は null。
 * referenceDate を渡すと、年の無い「M/D」「M月D日」も解釈する
 * （referenceDate 以前で最も近い年。例: 基準日が 2027/1/5 なら 12/30 は 2026/12/30）。
 */
export function normalizeDate(
  raw: string,
  _dateFormatHint?: string,
  referenceDate?: Date
): string | null {
  if (!raw?.trim()) return null;
  let s = toHalfWidth(raw.trim());
  s = s.replace(/年|月/g, "/").replace(/日/g, "");

  if (referenceDate) {
    const md = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
    if (md) {
      const ref = isoDate(
        referenceDate.getFullYear(),
        referenceDate.getMonth() + 1,
        referenceDate.getDate()
      )!;
      const year = referenceDate.getFullYear();
      const sameYear = isoDate(year, Number(md[1]), Number(md[2]));
      if (sameYear && sameYear <= ref) return sameYear;
      return isoDate(year - 1, Number(md[1]), Number(md[2]));
    }
  }

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
 * AI を使わずに、セルの中身から日付・店名・金額の列を推定する（AI が使えない時の代替）。
 * 判定できなければ null。
 */
export function detectCsvStructure(matrix: string[][]): CsvStructureAnalysis | null {
  const width = matrix.reduce((m, r) => Math.max(m, r.length), 0);
  const nonEmptyRows = matrix.filter((r) => r.some((c) => c));
  if (width < 2 || nonEmptyRows.length === 0) return null;

  let dateColumnIndex = -1;
  let bestDateHits = 0;
  for (let col = 0; col < width; col++) {
    const hits = nonEmptyRows.filter((r) => normalizeDate(r[col] ?? "")).length;
    if (hits > bestDateHits) {
      bestDateHits = hits;
      dateColumnIndex = col;
    }
  }
  if (dateColumnIndex < 0 || bestDateHits < Math.max(1, nonEmptyRows.length * 0.5)) return null;

  const dataRowIndices = matrix
    .map((r, i) => (normalizeDate(r[dateColumnIndex] ?? "") ? i : -1))
    .filter((i) => i >= 0);
  const dataRows = dataRowIndices.map((i) => matrix[i]);
  const minHits = dataRows.length * 0.8;

  // 左端の金額列を利用金額とみなす。支払回数のような小さな数字だけの列は除く
  let amountColumnIndex = -1;
  for (let col = 0; col < width; col++) {
    if (col === dateColumnIndex) continue;
    const values = dataRows.map((r) => parseAmount(r[col] ?? "")).filter((v): v is number => v !== null);
    if (values.length >= minHits && values.some((v) => Math.abs(v) >= 100)) {
      amountColumnIndex = col;
      break;
    }
  }
  if (amountColumnIndex < 0) return null;

  let storeColumnIndex = -1;
  let bestDistinct = 1;
  for (let col = 0; col < width; col++) {
    if (col === dateColumnIndex || col === amountColumnIndex) continue;
    const texts = dataRows
      .map((r) => (r[col] ?? "").trim())
      .filter((c) => c && parseAmount(c) === null && !normalizeDate(c));
    const distinct = new Set(texts).size;
    if (texts.length >= minHits && distinct > bestDistinct) {
      bestDistinct = distinct;
      storeColumnIndex = col;
    }
  }
  if (storeColumnIndex < 0) return null;

  return {
    isCsv: true,
    confidence: "medium",
    hasHeader: false,
    headerRowIndex: null,
    dataStartRow: dataRowIndices[0],
    dateColumnIndex,
    storeColumnIndex,
    amountColumnIndex,
    dateFormat: "YYYY/M/D",
    amountFormat: "",
    skipRowIndices: [],
    notes: "AIを使わずにセルの内容から列を推定",
    unrecognized: false,
  };
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
