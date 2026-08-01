"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CategorySelect } from "@/components/ui/category-select";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { Category, ParsedTransaction } from "@/types";
import {
  Upload,
  FileText,
  Camera,
  PenLine,
  Check,
  AlertCircle,
  X,
  ChevronLeft,
  ChevronRight,
  Receipt,
} from "lucide-react";

type TabType = "csv" | "manual" | "image";

interface FileFailure {
  name: string;
  error: string;
}

interface ProgressState {
  kind: "csv" | "image";
  current: number;
  total: number;
  detectedCount: number;
}

type ConfirmRow =
  | {
      kind: "group-header";
      key: string;
      storeName: string;
      date: string;
      itemCount: number;
      totalAmount: number;
    }
  | { kind: "item"; key: string; tx: ParsedTransaction; index: number };

const PAGE_SIZE = 50;

function collectFiles(
  list: FileList | File[] | null,
  accept: (file: File) => boolean
): File[] {
  if (!list) return [];
  return Array.from(list).filter(accept);
}

function isCsvFile(file: File) {
  return (
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel" ||
    /\.csv$/i.test(file.name)
  );
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(jpe?g|png|gif|webp)$/i.test(file.name);
}

function sourceLabel(source: ParsedTransaction["source"]) {
  if (source === "CSV") return "CSV";
  if (source === "IMAGE") return "画像";
  return "手入力";
}

/** 同一レシートの品目をグループ化し、表示用の行配列を作る */
function buildConfirmRows(items: ParsedTransaction[]): ConfirmRow[] {
  const rows: ConfirmRow[] = [];
  let i = 0;
  while (i < items.length) {
    const tx = items[i];
    const groupId = tx.receiptGroupId;
    if (groupId) {
      let j = i;
      while (j < items.length && items[j].receiptGroupId === groupId) j += 1;
      const group = items.slice(i, j);
      if (group.length > 1) {
        const storeName =
          group.find((g) => g.storeName)?.storeName ||
          group[0].description.split(" / ")[0] ||
          "レシート";
        rows.push({
          kind: "group-header",
          key: `hdr-${groupId}`,
          storeName,
          date: group[0].date,
          itemCount: group.length,
          totalAmount: group.reduce((s, g) => s + g.amount, 0),
        });
      }
      for (let k = i; k < j; k++) {
        rows.push({
          kind: "item",
          key: `item-${k}`,
          tx: items[k],
          index: k,
        });
      }
      i = j;
    } else {
      rows.push({ kind: "item", key: `item-${i}`, tx, index: i });
      i += 1;
    }
  }
  return rows;
}

export default function ImportPage() {
  const [tab, setTab] = useState<TabType>("csv");
  const [parsed, setParsed] = useState<ParsedTransaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [failures, setFailures] = useState<FileFailure[]>([]);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [page, setPage] = useState(1);

  const [csvFiles, setCsvFiles] = useState<File[]>([]);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState<"csv" | "image" | null>(null);

  const [manualForm, setManualForm] = useState({
    date: new Date().toISOString().split("T")[0],
    description: "",
    amount: "",
  });

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setCategories(Array.isArray(data) ? data : []))
      .catch(() => setCategories([]));
  }, []);

  const totalPages = Math.max(1, Math.ceil(parsed.length / PAGE_SIZE));
  const pagedParsed = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return parsed.slice(start, start + PAGE_SIZE);
  }, [parsed, page]);

  const confirmRows = useMemo(
    () => buildConfirmRows(pagedParsed),
    [pagedParsed]
  );

  /** ページ先頭オフセットを加味したグローバル index */
  const pageOffset = (page - 1) * PAGE_SIZE;

  const classifiedCount = useMemo(
    () => parsed.filter((tx) => tx.categoryId).length,
    [parsed]
  );

  const appendTransactions = (items: ParsedTransaction[]) => {
    setParsed((prev) => [...prev, ...items]);
    setPage(1);
  };

  const updateCategory = (index: number, categoryId: string) => {
    setParsed((prev) =>
      prev.map((tx, i) => {
        if (i !== index) return tx;
        if (!categoryId) {
          return {
            ...tx,
            categoryId: null,
            categoryName: null,
            categoryColor: null,
          };
        }
        const cat = categories.find((c) => c.id === categoryId);
        return {
          ...tx,
          categoryId,
          categoryName: cat?.name ?? null,
          categoryColor: cat?.color ?? null,
        };
      })
    );
  };

  const processCsvFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setLoading(true);
    setMessage(null);
    setFailures([]);
    setProgress({ kind: "csv", current: 0, total: files.length, detectedCount: 0 });

    const merged: ParsedTransaction[] = [];
    const errors: FileFailure[] = [];
    let detected = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setProgress({
        kind: "csv",
        current: i + 1,
        total: files.length,
        detectedCount: detected,
      });

      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/import", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) {
          errors.push({ name: file.name, error: data.error ?? "解析に失敗しました" });
          continue;
        }
        const txs: ParsedTransaction[] = (data.transactions ?? []).map(
          (tx: ParsedTransaction) => ({ ...tx, source: "CSV" as const })
        );
        merged.push(...txs);
        detected += txs.length;
        setProgress({
          kind: "csv",
          current: i + 1,
          total: files.length,
          detectedCount: detected,
        });
      } catch {
        errors.push({ name: file.name, error: "ネットワークエラーまたは解析失敗" });
      }
    }

    if (merged.length > 0) appendTransactions(merged);
    setFailures(errors);
    if (merged.length > 0) {
      setMessage({
        type: "success",
        text: `${files.length}件中${files.length - errors.length}件のCSVから合計${merged.length}件の明細を検出し、AIがカテゴリを提案しました`,
      });
      // カテゴリ一覧を最新化（seed直後のため）
      fetch("/api/categories")
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => setCategories(Array.isArray(data) ? data : []))
        .catch(() => undefined);
    } else if (errors.length > 0) {
      setMessage({
        type: "error",
        text: "読み込める明細がありませんでした",
      });
    }
    setProgress(null);
    setLoading(false);
    setCsvFiles([]);
  };

  const processImageFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setLoading(true);
    setMessage(null);
    setFailures([]);
    setProgress({ kind: "image", current: 0, total: files.length, detectedCount: 0 });

    const merged: ParsedTransaction[] = [];
    const errors: FileFailure[] = [];
    let detected = 0;

    // レート制限を避けるため画像は1枚ずつ順次処理
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setProgress({
        kind: "image",
        current: i + 1,
        total: files.length,
        detectedCount: detected,
      });

      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/import/image", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) {
          errors.push({ name: file.name, error: data.error ?? "解析に失敗しました" });
          continue;
        }
        const groupId =
          typeof data.receiptGroupId === "string"
            ? data.receiptGroupId
            : `receipt-${file.name}-${Date.now()}`;
        const txs: ParsedTransaction[] = (data.transactions ?? []).map(
          (tx: ParsedTransaction) => ({
            ...tx,
            amount: Math.round(Number(tx.amount)),
            source: "IMAGE" as const,
            receiptGroupId: tx.receiptGroupId ?? groupId,
            storeName: tx.storeName ?? null,
            itemName: tx.itemName ?? null,
          })
        );
        if (txs.length === 0) {
          errors.push({
            name: file.name,
            error: "取引を読み取れませんでした",
          });
          continue;
        }
        merged.push(...txs);
        detected += txs.length;
        setProgress({
          kind: "image",
          current: i + 1,
          total: files.length,
          detectedCount: detected,
        });
      } catch {
        errors.push({ name: file.name, error: "ネットワークエラーまたは解析失敗" });
      }
    }

    if (merged.length > 0) appendTransactions(merged);
    setFailures(errors);
    if (merged.length > 0) {
      setMessage({
        type: "success",
        text: `${files.length}枚中${files.length - errors.length}枚の画像から合計${merged.length}件の明細を検出しました`,
      });
    } else if (errors.length > 0) {
      setMessage({
        type: "error",
        text: "読み取れる明細がありませんでした",
      });
    }
    setProgress(null);
    setLoading(false);
    setImageFiles([]);
  };

  const handleManualAdd = () => {
    if (!manualForm.description || !manualForm.amount) return;
    const tx: ParsedTransaction = {
      date: manualForm.date,
      description: manualForm.description,
      amount: parseInt(manualForm.amount, 10),
      source: "MANUAL",
    };
    appendTransactions([tx]);
    setManualForm({
      date: new Date().toISOString().split("T")[0],
      description: "",
      amount: "",
    });
  };

  const removeItem = (index: number) => {
    setParsed((prev) => {
      const next = prev.filter((_, i) => i !== index);
      const nextPages = Math.max(1, Math.ceil(next.length / PAGE_SIZE));
      if (page > nextPages) setPage(nextPages);
      return next;
    });
  };

  const confirmAndSave = async () => {
    if (parsed.length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/import/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: parsed, autoClassify: true }),
      });
      if (!res.ok) {
        setMessage({ type: "error", text: "保存に失敗しました" });
        return;
      }
      const data = await res.json();
      const skippedCount =
        typeof data.skippedCount === "number" ? data.skippedCount : 0;
      setMessage({
        type: "success",
        text:
          skippedCount > 0
            ? `${data.count}件を保存し、重複${skippedCount}件を除外しました`
            : `${data.count}件の取引を保存しました`,
      });
      setParsed([]);
      setFailures([]);
      setCsvFiles([]);
      setImageFiles([]);
      setPage(1);
    } finally {
      setSaving(false);
    }
  };

  const onDropFiles = (
    e: React.DragEvent,
    kind: "csv" | "image"
  ) => {
    e.preventDefault();
    setDragOver(null);
    const files = collectFiles(
      e.dataTransfer.files,
      kind === "csv" ? isCsvFile : isImageFile
    );
    if (kind === "csv") setCsvFiles(files);
    else setImageFiles(files);
  };

  const tabs: { key: TabType; label: string; icon: React.ReactNode }[] = [
    { key: "csv", label: "CSV", icon: <FileText className="h-4 w-4" /> },
    { key: "manual", label: "手入力", icon: <PenLine className="h-4 w-4" /> },
    { key: "image", label: "画像", icon: <Camera className="h-4 w-4" /> },
  ];

  const inputClass =
    "h-11 w-full rounded-lg border border-gray-300 px-3 text-base focus:border-indigo-500 focus:outline-none md:h-auto md:py-2 md:text-sm";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">データ取り込み</h1>

      {message && (
        <div
          className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {message.type === "success" ? (
            <Check className="h-4 w-4 flex-shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
          )}
          {message.text}
        </div>
      )}

      {failures.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">
            {failures.length}件のファイルは読み込めませんでした
          </p>
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {failures.map((f) => (
              <li key={`${f.name}-${f.error}`} className="break-all">
                ・{f.name}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {progress && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800">
          {progress.kind === "csv" ? (
            <p>
              {progress.total}件のファイルを読み込み中（{progress.current}/{progress.total}）…
              {" "}合計{progress.detectedCount}件の明細を検出
            </p>
          ) : (
            <p>
              {progress.total}枚中{progress.current}枚を解析中…
              {" "}合計{progress.detectedCount}件の明細を検出
            </p>
          )}
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-indigo-100">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${(progress.current / progress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid w-full grid-cols-3 gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 sm:flex sm:w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-sm font-medium transition-colors sm:gap-2 sm:px-4 ${
              tab === t.key
                ? "bg-white text-indigo-700 shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {tab === "csv" && "CSV ファイルをアップロード（複数可）"}
            {tab === "manual" && "手動で支出を入力"}
            {tab === "image" && "レシート／利用明細の画像をアップロード（複数可）"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {tab === "csv" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                複数のカード会社CSVをまとめて選択できます。ファイルごとに列を自動推定し、明細を1つのリストに統合します。
              </p>
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver("csv");
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => onDropFiles(e, "csv")}
                className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 transition-colors sm:p-10 ${
                  dragOver === "csv"
                    ? "border-indigo-400 bg-indigo-50/50"
                    : "border-gray-300 hover:border-indigo-400 hover:bg-indigo-50/30"
                }`}
              >
                <Upload className="h-8 w-8 text-gray-400" />
                <span className="px-2 text-center text-sm text-gray-500">
                  {csvFiles.length > 0
                    ? `${csvFiles.length}件のCSVを選択中`
                    : "CSV を複数選択、またはここにドロップ"}
                </span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    setCsvFiles(collectFiles(e.target.files, isCsvFile));
                    e.target.value = "";
                  }}
                />
              </label>
              {csvFiles.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
                  {csvFiles.map((f) => (
                    <li key={`${f.name}-${f.size}`} className="flex items-center justify-between gap-2">
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        className="flex-shrink-0 text-gray-400 hover:text-gray-600"
                        onClick={() =>
                          setCsvFiles((prev) => prev.filter((x) => x !== f))
                        }
                        aria-label={`${f.name} を除外`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                onClick={() => processCsvFiles(csvFiles)}
                disabled={csvFiles.length === 0 || loading}
                className="w-full"
              >
                {loading && progress?.kind === "csv"
                  ? `${progress.current}/${progress.total} 件を読み込み中...`
                  : `選択したCSVを解析する（${csvFiles.length}件）`}
              </Button>
            </div>
          )}

          {tab === "manual" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">日付</label>
                  <input
                    type="date"
                    className={inputClass}
                    value={manualForm.date}
                    onChange={(e) => setManualForm((p) => ({ ...p, date: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">利用先</label>
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="例: スターバックス"
                    value={manualForm.description}
                    onChange={(e) => setManualForm((p) => ({ ...p, description: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">金額（円）</label>
                  <input
                    type="number"
                    className={inputClass}
                    placeholder="例: 500"
                    value={manualForm.amount}
                    onChange={(e) => setManualForm((p) => ({ ...p, amount: e.target.value }))}
                  />
                </div>
              </div>
              <Button
                className="w-full sm:w-auto"
                onClick={handleManualAdd}
                disabled={!manualForm.description || !manualForm.amount}
              >
                リストに追加
              </Button>
            </div>
          )}

          {tab === "image" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                レシートや利用明細の画像を複数選択できます。レシートは品目ごとに分割・分類し、
                品目が読めない場合は店名ベースの1件として扱います。1枚ずつ順に解析します。
              </p>
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver("image");
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={(e) => onDropFiles(e, "image")}
                className={`flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 transition-colors sm:p-10 ${
                  dragOver === "image"
                    ? "border-indigo-400 bg-indigo-50/50"
                    : "border-gray-300 hover:border-indigo-400 hover:bg-indigo-50/30"
                }`}
              >
                <Camera className="h-8 w-8 text-gray-400" />
                <span className="px-2 text-center text-sm text-gray-500">
                  {imageFiles.length > 0
                    ? `${imageFiles.length}枚の画像を選択中`
                    : "画像を複数選択、撮影、またはここにドロップ"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    setImageFiles(collectFiles(e.target.files, isImageFile));
                    e.target.value = "";
                  }}
                />
              </label>
              {imageFiles.length > 0 && (
                <ul className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm text-gray-700">
                  {imageFiles.map((f) => (
                    <li key={`${f.name}-${f.size}-${f.lastModified}`} className="flex items-center justify-between gap-2">
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        className="flex-shrink-0 text-gray-400 hover:text-gray-600"
                        onClick={() =>
                          setImageFiles((prev) => prev.filter((x) => x !== f))
                        }
                        aria-label={`${f.name} を除外`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                onClick={() => processImageFiles(imageFiles)}
                disabled={imageFiles.length === 0 || loading}
                className="w-full"
              >
                {loading && progress?.kind === "image"
                  ? `${progress.total}枚中${progress.current}枚を解析中...`
                  : `選択した画像を解析する（${imageFiles.length}枚）`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {parsed.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>
                確認・分類（合計 {parsed.length}件）
              </CardTitle>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={() => {
                    setParsed([]);
                    setFailures([]);
                    setPage(1);
                  }}
                  disabled={saving || loading}
                >
                  クリア
                </Button>
                <Button
                  className="w-full sm:w-auto"
                  onClick={confirmAndSave}
                  disabled={saving || loading}
                >
                  {saving
                    ? "保存中..."
                    : `全て確定してDBに保存（${parsed.length}件）`}
                </Button>
              </div>
            </div>
            <p className="mt-1 text-sm text-gray-500">
              AIがカテゴリを自動提案しています（{classifiedCount}/{parsed.length}件に分類済み）。
              プルダウンでその場で変更できます。同一レシートから分割された品目はグループ表示されます。
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-gray-100">
              {/* PC: テーブル */}
              <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-gray-200 text-left text-gray-500">
                      <th className="px-4 py-3 font-medium">日付</th>
                      <th className="px-4 py-3 font-medium">利用先 / 品目</th>
                      <th className="px-4 py-3 font-medium">金額</th>
                      <th className="px-4 py-3 font-medium">カテゴリ</th>
                      <th className="px-4 py-3 font-medium">ソース</th>
                      <th className="px-4 py-3 font-medium">削除</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {confirmRows.map((row) => {
                      if (row.kind === "group-header") {
                        return (
                          <tr key={row.key} className="bg-indigo-50/60">
                            <td colSpan={6} className="px-4 py-2.5">
                              <div className="flex flex-wrap items-center gap-2 text-sm text-indigo-900">
                                <Receipt className="h-4 w-4 flex-shrink-0" />
                                <span className="font-semibold">{row.storeName}</span>
                                <span className="text-indigo-700">
                                  {formatDate(row.date)}
                                </span>
                                <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs">
                                  {row.itemCount}品目
                                </span>
                                <span className="text-xs text-indigo-700">
                                  小計 {formatCurrency(row.totalAmount)}
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      }
                      const { tx, index: localIndex } = row;
                      const index = pageOffset + localIndex;
                      return (
                        <tr
                          key={row.key}
                          className={`hover:bg-gray-50 ${
                            tx.receiptGroupId ? "bg-indigo-50/20" : ""
                          }`}
                        >
                          <td className="px-4 py-3 text-gray-600">
                            {formatDate(tx.date)}
                          </td>
                          <td className="px-4 py-3 font-medium">
                            {tx.itemName ? (
                              <div>
                                <p>{tx.itemName}</p>
                                {tx.storeName && (
                                  <p className="text-xs font-normal text-gray-500">
                                    {tx.storeName}
                                  </p>
                                )}
                              </div>
                            ) : (
                              tx.description
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {formatCurrency(tx.amount)}
                          </td>
                          <td className="px-4 py-3">
                            <CategorySelect
                              compact
                              categories={categories}
                              value={tx.categoryId}
                              onChange={(id) => updateCategory(index, id)}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                              {sourceLabel(tx.source)}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => removeItem(index)}
                              className="text-xs text-red-400 hover:text-red-600"
                            >
                              削除
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* スマホ: カード */}
              <div className="space-y-3 p-3 md:hidden">
                {confirmRows.map((row) => {
                  if (row.kind === "group-header") {
                    return (
                      <div
                        key={row.key}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900"
                      >
                        <div className="flex items-center gap-2 font-semibold">
                          <Receipt className="h-4 w-4" />
                          {row.storeName}
                        </div>
                        <p className="mt-1 text-xs text-indigo-700">
                          {formatDate(row.date)} ・ {row.itemCount}品目 ・ 小計{" "}
                          {formatCurrency(row.totalAmount)}
                        </p>
                      </div>
                    );
                  }
                  const { tx, index: localIndex } = row;
                  const index = pageOffset + localIndex;
                  return (
                    <div
                      key={row.key}
                      className={`rounded-xl border p-4 ${
                        tx.receiptGroupId
                          ? "border-indigo-200 bg-indigo-50/20"
                          : "border-gray-200"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-gray-500">
                            {formatDate(tx.date)}
                          </p>
                          <p className="mt-1 truncate font-medium text-gray-900">
                            {tx.itemName || tx.description}
                          </p>
                          {tx.itemName && tx.storeName && (
                            <p className="mt-0.5 text-xs text-gray-500">
                              {tx.storeName}
                            </p>
                          )}
                          <span className="mt-2 inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                            {sourceLabel(tx.source)}
                          </span>
                        </div>
                        <p className="flex-shrink-0 font-bold">
                          {formatCurrency(tx.amount)}
                        </p>
                      </div>
                      <div className="mt-3">
                        <CategorySelect
                          categories={categories}
                          value={tx.categoryId}
                          onChange={(id) => updateCategory(index, id)}
                        />
                      </div>
                      <Button
                        variant="outline"
                        className="mt-3 w-full text-red-500"
                        onClick={() => removeItem(index)}
                      >
                        削除
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>

            {parsed.length > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label="前のページ"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-gray-600">
                  {page} / {totalPages} ページ（{PAGE_SIZE}件ずつ）
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-label="次のページ"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
