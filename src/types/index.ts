export type Source = "CSV" | "MANUAL" | "IMAGE";

export interface Category {
  id: string;
  name: string;
  description?: string | null;
  color: string;
  icon?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Transaction {
  id: string;
  date: Date;
  description: string;
  amount: number;
  categoryId?: string | null;
  category?: Category | null;
  source: Source;
  memo?: string | null;
  confirmed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Rule {
  id: string;
  keyword: string;
  categoryId: string;
  category?: Category;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

// CSV インポート関連
export interface CsvRow {
  [key: string]: string;
}

/** @deprecated 列名ベースの旧マッピング。AI構造解析結果を優先する */
export interface CsvColumnMapping {
  date: string;
  description: string;
  amount: string;
}

/**
 * Claude API による CSV 構造解析結果。
 * 列インデックスは 0 始まり。
 */
export interface CsvStructureAnalysis {
  isCsv: boolean;
  confidence: "high" | "medium" | "low";
  hasHeader: boolean;
  headerRowIndex: number | null;
  dataStartRow: number;
  dateColumnIndex: number;
  storeColumnIndex: number;
  amountColumnIndex: number;
  dateFormat: string;
  amountFormat: string;
  /** データ行ではないと判断した行（0始まり）。任意 */
  skipRowIndices: number[];
  notes: string;
  /** true の場合はユーザーへ認識失敗を返す */
  unrecognized: boolean;
}

export interface ParsedTransaction {
  date: string;
  description: string;
  amount: number;
  source: Source;
  categoryId?: string | null;
  categoryName?: string | null;
  categoryColor?: string | null;
  /** 同一レシート画像から分割された品目をまとめるためのグループID */
  receiptGroupId?: string | null;
  /** レシートの店名（品目分割時） */
  storeName?: string | null;
  /** レシート上の品目名（品目分割時） */
  itemName?: string | null;
}

/** Vision OCR が返す抽出結果（分類前） */
export interface ExtractedImageTransaction {
  date: string;
  description: string;
  amount: number;
  storeName?: string | null;
  itemName?: string | null;
  /** AI が提案したカテゴリ名（候補に無い/未分類なら null） */
  categoryName?: string | null;
}

// AI レスポンス
export interface ClassificationResult {
  transactionId?: string;
  description: string;
  suggestedCategoryId?: string;
  suggestedCategoryName: string;
  confidence: number;
}

// ダッシュボード集計
export interface CategorySummary {
  categoryId: string | null;
  categoryName: string;
  color: string;
  total: number;
  percentage: number;
}

export interface MonthlySummary {
  month: string; // YYYY-MM
  total: number;
  categories: CategorySummary[];
}
