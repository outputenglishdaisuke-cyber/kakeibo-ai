import type { CsvStructureAnalysis } from "@/types";
import { normalizeDate, parseAmount } from "@/lib/csv-parser";

/**
 * カード会社ごとの CSV の列の位置（0始まり）。列の位置はここだけで管理する。
 * 月・期間は利用日の列だけから決め、支払月の列は表示用に読むだけにする。
 */
export interface CardCsvFormat {
  id: string;
  label: string;
  dateColumn: number;
  storeColumn: number;
  /** 利用金額の列（支払金額の列ではない） */
  amountColumn: number;
  paymentMonthColumn: number | null;
  /** 利用日を読めた行が、この形式のデータ行か */
  isDataRow: (row: string[]) => boolean;
}

export const CARD_CSV_FORMATS: CardCsvFormat[] = [
  {
    // 0:利用日 1:店名 2:本人区分 3:支払区分 4:空 5:支払月('26/10) 6:利用金額 7:支払金額 8〜12:空
    id: "card-13col",
    label: "カード明細（ヘッダーなし・13列）",
    dateColumn: 0,
    storeColumn: 1,
    amountColumn: 6,
    paymentMonthColumn: 5,
    isDataRow: (row) =>
      row.length >= 8 && /^'?\d{2}\/\d{1,2}$/.test(row[5] ?? "") && parseAmount(row[6] ?? "") !== null,
  },
  {
    // 先頭に氏名・カード番号の行、末尾に合計行。0:利用日 1:店名 2:利用金額 3:支払区分 4:回数 5:支払金額 6:空
    id: "olive-7col",
    label: "カード明細（7列・氏名行と合計行あり）",
    dateColumn: 0,
    storeColumn: 1,
    amountColumn: 2,
    paymentMonthColumn: null,
    isDataRow: (row) =>
      row.length === 7 && parseAmount(row[2] ?? "") !== null && parseAmount(row[5] ?? "") !== null,
  },
];

/** 支払月の表記（例: '26/10）を YYYY-MM にする */
export function parsePaymentMonth(raw: string): string | null {
  const m = (raw ?? "").trim().match(/^'?(\d{2})\/(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `20${m[1]}-${String(month).padStart(2, "0")}`;
}

/** 設定済みの形式に当てはまるか判定し、列の構造を返す。当てはまらなければ null */
export function detectCardCsvFormat(matrix: string[][]): {
  format: CardCsvFormat;
  structure: CsvStructureAnalysis;
  paymentMonth: string | null;
} | null {
  const dateRows = matrix
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => normalizeDate(row[0] ?? ""));
  if (dateRows.length === 0) return null;

  for (const format of CARD_CSV_FORMATS) {
    const hits = dateRows.filter(({ row }) => format.isDataRow(row));
    if (hits.length < dateRows.length * 0.9) continue;

    const months = new Map<string, number>();
    if (format.paymentMonthColumn !== null) {
      for (const { row } of hits) {
        const pm = parsePaymentMonth(row[format.paymentMonthColumn] ?? "");
        if (pm) months.set(pm, (months.get(pm) ?? 0) + 1);
      }
    }
    const paymentMonth = [...months].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      format,
      paymentMonth,
      structure: {
        isCsv: true,
        confidence: "high",
        hasHeader: false,
        headerRowIndex: null,
        dataStartRow: dateRows[0].index,
        dateColumnIndex: format.dateColumn,
        storeColumnIndex: format.storeColumn,
        amountColumnIndex: format.amountColumn,
        dateFormat: "YYYY/M/D",
        amountFormat: "",
        skipRowIndices: [],
        notes: format.label,
        unrecognized: false,
      },
    };
  }
  return null;
}
