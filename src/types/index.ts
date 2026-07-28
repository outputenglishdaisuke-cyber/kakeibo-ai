export type Source = "CSV" | "MANUAL" | "IMAGE";

export interface Category {
  id: string;
  name: string;
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

export interface CsvColumnMapping {
  date: string;
  description: string;
  amount: string;
}

export interface ParsedTransaction {
  date: string;
  description: string;
  amount: number;
  source: Source;
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
