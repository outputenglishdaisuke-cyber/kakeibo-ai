"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, getMonthKey } from "@/lib/utils";
import type { Transaction, Category } from "@/types";
import {
  Pencil,
  Trash2,
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Filter,
  RotateCcw,
} from "lucide-react";

type SourceFilter = Transaction["source"];

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "CSV", label: "CSV" },
  { value: "IMAGE", label: "画像" },
  { value: "MANUAL", label: "手入力" },
];

const UNCATEGORIZED_KEY = "uncategorized";

function sourceLabel(source: Transaction["source"]) {
  if (source === "CSV") return "CSV";
  if (source === "IMAGE") return "画像";
  return "手入力";
}

function displayMonthLabel(monthKey: string) {
  const [y, m] = monthKey.split("-");
  return `${y}年${parseInt(m, 10)}月`;
}

function parseCategoriesFromUrl(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseSourcesFromUrl(raw: string | null): SourceFilter[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SourceFilter =>
      s === "CSV" || s === "IMAGE" || s === "MANUAL"
    );
}

function readFiltersFromUrl(): {
  month: string;
  categoryKeys: string[];
  sources: SourceFilter[];
} {
  if (typeof window === "undefined") {
    return {
      month: getMonthKey(new Date()),
      categoryKeys: [],
      sources: [],
    };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    month: params.get("month") || getMonthKey(new Date()),
    categoryKeys: parseCategoriesFromUrl(params.get("categories")),
    sources: parseSourcesFromUrl(params.get("sources")),
  };
}

function writeFiltersToUrl(
  month: string,
  categoryKeys: string[],
  sources: SourceFilter[]
) {
  const params = new URLSearchParams();
  params.set("month", month);
  if (categoryKeys.length > 0) {
    params.set("categories", categoryKeys.join(","));
  }
  if (sources.length > 0) {
    params.set("sources", sources.join(","));
  }
  const qs = params.toString();
  const next = qs ? `/transactions?${qs}` : "/transactions";
  window.history.replaceState(null, "", next);
}

type ConfirmState =
  | { type: "selected"; count: number; ids: string[] }
  | { type: "month"; month: string; count: number }
  | { type: "all"; count: number };

export default function TransactionsPage() {
  const initial = useRef(readFiltersFromUrl());
  const [currentMonth, setCurrentMonth] = useState(initial.current.month);
  const [selectedCategoryKeys, setSelectedCategoryKeys] = useState<string[]>(
    initial.current.categoryKeys
  );
  const [selectedSources, setSelectedSources] = useState<SourceFilter[]>(
    initial.current.sources
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategoryId, setEditCategoryId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmState | null>(null);
  const [deleting, setDeleting] = useState(false);

  const hasActiveFilters =
    selectedCategoryKeys.length > 0 || selectedSources.length > 0;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("month", currentMonth);
      if (selectedCategoryKeys.length > 0) {
        params.set("categories", selectedCategoryKeys.join(","));
      }
      if (selectedSources.length > 0) {
        params.set("sources", selectedSources.join(","));
      }

      const [txRes, catRes] = await Promise.all([
        fetch(`/api/transactions?${params.toString()}`),
        fetch("/api/categories"),
      ]);
      if (txRes.ok) setTransactions(await txRes.json());
      if (catRes.ok) setCategories(await catRes.json());
      setSelectedIds(new Set());
    } finally {
      setLoading(false);
    }
  }, [currentMonth, selectedCategoryKeys, selectedSources]);

  useEffect(() => {
    writeFiltersToUrl(currentMonth, selectedCategoryKeys, selectedSources);
  }, [currentMonth, selectedCategoryKeys, selectedSources]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const allSelected = useMemo(
    () => transactions.length > 0 && selectedIds.size === transactions.length,
    [transactions, selectedIds]
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(transactions.map((tx) => tx.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const startEdit = (tx: Transaction) => {
    setEditingId(tx.id);
    setEditCategoryId(tx.categoryId ?? "");
  };

  const saveEdit = async (id: string) => {
    await fetch(`/api/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId: editCategoryId || null }),
    });
    setEditingId(null);
    fetchAll();
  };

  const deleteTransaction = async (id: string) => {
    if (!confirm("この取引を削除しますか？")) return;
    await fetch(`/api/transactions/${id}`, { method: "DELETE" });
    fetchAll();
  };

  const changeMonth = (delta: number) => {
    const [y, m] = currentMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setCurrentMonth(getMonthKey(d));
  };

  const toggleCategoryKey = (key: string) => {
    setSelectedCategoryKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const toggleSource = (source: SourceFilter) => {
    setSelectedSources((prev) =>
      prev.includes(source)
        ? prev.filter((s) => s !== source)
        : [...prev, source]
    );
  };

  const resetFilters = () => {
    setSelectedCategoryKeys([]);
    setSelectedSources([]);
    setCurrentMonth(getMonthKey(new Date()));
  };

  const openSelectedDelete = () => {
    if (selectedIds.size === 0) return;
    setConfirmDialog({
      type: "selected",
      count: selectedIds.size,
      ids: Array.from(selectedIds),
    });
  };

  const openMonthDelete = async () => {
    const res = await fetch(
      `/api/transactions/bulk?mode=month&month=${encodeURIComponent(currentMonth)}`
    );
    const data = await res.json();
    const count = typeof data.count === "number" ? data.count : transactions.length;
    if (count === 0) {
      setMessage({ type: "error", text: "この月に削除できるデータはありません" });
      return;
    }
    setConfirmDialog({ type: "month", month: currentMonth, count });
  };

  const openAllDelete = async () => {
    const res = await fetch("/api/transactions/bulk?mode=all");
    const data = await res.json();
    const count = typeof data.count === "number" ? data.count : 0;
    if (count === 0) {
      setMessage({ type: "error", text: "削除できるデータはありません" });
      return;
    }
    setConfirmDialog({ type: "all", count });
  };

  const executeBulkDelete = async () => {
    if (!confirmDialog) return;
    setDeleting(true);
    setMessage(null);
    try {
      let body: Record<string, unknown>;
      if (confirmDialog.type === "selected") {
        body = { mode: "ids", ids: confirmDialog.ids };
      } else if (confirmDialog.type === "month") {
        body = { mode: "month", month: confirmDialog.month };
      } else {
        body = { mode: "all" };
      }

      const res = await fetch("/api/transactions/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({
          type: "error",
          text: typeof data.error === "string" ? data.error : "一括削除に失敗しました",
        });
        return;
      }
      setMessage({
        type: "success",
        text: `${data.deletedCount}件のデータを削除しました`,
      });
      setConfirmDialog(null);
      setSelectedIds(new Set());
      await fetchAll();
    } catch {
      setMessage({ type: "error", text: "一括削除に失敗しました" });
    } finally {
      setDeleting(false);
    }
  };

  const total = transactions.reduce((s, tx) => s + tx.amount, 0);

  const renderCategorySelect = (compact = false) => (
    <select
      className={
        compact
          ? "rounded border border-gray-300 px-2 py-1 text-sm"
          : "h-11 w-full rounded-lg border border-gray-300 px-3 text-base"
      }
      value={editCategoryId}
      onChange={(e) => setEditCategoryId(e.target.value)}
    >
      <option value="">未分類</option>
      {categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );

  const confirmTitle =
    confirmDialog?.type === "selected"
      ? `選択した${confirmDialog.count}件を削除`
      : confirmDialog?.type === "month"
        ? `${displayMonthLabel(confirmDialog.month)}の全データを削除`
        : "全期間の全データを削除";

  const confirmMessage =
    confirmDialog?.type === "selected"
      ? `本当に選択した${confirmDialog.count}件のデータを削除しますか？この操作は取り消せません。`
      : confirmDialog?.type === "month"
        ? `本当に${displayMonthLabel(confirmDialog.month)}の全データ（${confirmDialog.count}件）を削除しますか？この操作は取り消せません。他の月のデータには影響しません。`
        : `本当に全期間の全データ（${confirmDialog?.count ?? 0}件）を削除しますか？この操作は取り消せません。すべての取引が消えます。`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">明細一覧</h1>
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 sm:h-9 sm:w-9"
            onClick={() => changeMonth(-1)}
            aria-label="前月"
          >
            <ChevronLeft className="h-5 w-5 sm:h-4 sm:w-4" />
          </Button>
          <span className="min-w-[120px] text-center text-base font-semibold sm:min-w-[90px] sm:text-sm sm:font-medium">
            {displayMonthLabel(currentMonth)}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-12 w-12 sm:h-9 sm:w-9"
            onClick={() => changeMonth(1)}
            disabled={currentMonth >= getMonthKey(new Date())}
            aria-label="次月"
          >
            <ChevronRight className="h-5 w-5 sm:h-4 sm:w-4" />
          </Button>
        </div>
      </div>

      {message && (
        <div
          className={`rounded-lg px-4 py-3 text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* フィルター */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2 text-base">
              <Filter className="h-4 w-4" />
              フィルター
            </CardTitle>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-indigo-600">
                {loading ? "読み込み中..." : `${transactions.length}件表示中`}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={resetFilters}
                disabled={!hasActiveFilters && currentMonth === getMonthKey(new Date())}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                フィルターをリセット
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">カテゴリ（複数選択可）</p>
            <div className="flex flex-wrap gap-2">
              {categories.map((c) => {
                const checked = selectedCategoryKeys.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      checked
                        ? "border-indigo-300 bg-indigo-50 text-indigo-800"
                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300"
                      checked={checked}
                      onChange={() => toggleCategoryKey(c.id)}
                    />
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: c.color }}
                      aria-hidden
                    />
                    {c.name}
                  </label>
                );
              })}
              <label
                className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                  selectedCategoryKeys.includes(UNCATEGORIZED_KEY)
                    ? "border-indigo-300 bg-indigo-50 text-indigo-800"
                    : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300"
                  checked={selectedCategoryKeys.includes(UNCATEGORIZED_KEY)}
                  onChange={() => toggleCategoryKey(UNCATEGORIZED_KEY)}
                />
                未分類
              </label>
            </div>
            {selectedCategoryKeys.length === 0 && (
              <p className="mt-1.5 text-xs text-gray-400">
                未選択時はすべてのカテゴリを表示します
              </p>
            )}
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">取り込み元（複数選択可）</p>
            <div className="flex flex-wrap gap-2">
              {SOURCE_OPTIONS.map((opt) => {
                const checked = selectedSources.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      checked
                        ? "border-indigo-300 bg-indigo-50 text-indigo-800"
                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-gray-300"
                      checked={checked}
                      onChange={() => toggleSource(opt.value)}
                    />
                    {opt.label}
                  </label>
                );
              })}
            </div>
            {selectedSources.length === 0 && (
              <p className="mt-1.5 text-xs text-gray-400">
                未選択時はすべての取り込み元を表示します
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 一括操作バー */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <p className="text-sm font-medium text-gray-700">一括削除</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button
              variant="outline"
              onClick={selectAll}
              disabled={loading || transactions.length === 0}
            >
              全て選択
            </Button>
            <Button
              variant="outline"
              onClick={clearSelection}
              disabled={selectedIds.size === 0}
            >
              選択解除
            </Button>
            <Button
              variant="destructive"
              onClick={openSelectedDelete}
              disabled={selectedIds.size === 0 || deleting}
            >
              <Trash2 className="h-4 w-4" />
              選択した{selectedIds.size > 0 ? selectedIds.size : ""}件を削除
            </Button>
            <Button
              variant="outline"
              className="border-red-200 text-red-600 hover:bg-red-50"
              onClick={openMonthDelete}
              disabled={loading || deleting}
            >
              この月（{displayMonthLabel(currentMonth)}）を全て削除
            </Button>
            <Button
              variant="destructive"
              onClick={openAllDelete}
              disabled={deleting}
            >
              全期間の全データを削除
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>
              取引一覧（{transactions.length}件表示中
              {hasActiveFilters ? "・フィルター適用中" : ""}）
            </CardTitle>
            <span className="text-lg font-bold text-indigo-600">
              合計: {formatCurrency(total)}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-12 text-center text-gray-400">読み込み中...</div>
          ) : transactions.length === 0 ? (
            <div className="py-12 text-center text-gray-400">
              {hasActiveFilters
                ? "条件に一致する取引はありません"
                : "この月の取引はありません"}
            </div>
          ) : (
            <>
              {/* PC: テーブル */}
              <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-gray-500">
                      <th className="w-10 pb-3 pr-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300"
                          checked={allSelected}
                          onChange={(e) =>
                            e.target.checked ? selectAll() : clearSelection()
                          }
                          aria-label="全て選択"
                        />
                      </th>
                      <th className="pb-3 pr-4 font-medium">日付</th>
                      <th className="pb-3 pr-4 font-medium">利用先</th>
                      <th className="pb-3 pr-4 font-medium">金額</th>
                      <th className="pb-3 pr-4 font-medium">カテゴリ</th>
                      <th className="pb-3 pr-4 font-medium">ソース</th>
                      <th className="pb-3 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {transactions.map((tx) => (
                      <tr
                        key={tx.id}
                        className={`hover:bg-gray-50 ${
                          selectedIds.has(tx.id) ? "bg-indigo-50/40" : ""
                        }`}
                      >
                        <td className="py-3 pr-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-gray-300"
                            checked={selectedIds.has(tx.id)}
                            onChange={() => toggleSelect(tx.id)}
                            aria-label={`${tx.description} を選択`}
                          />
                        </td>
                        <td className="py-3 pr-4 text-gray-600">
                          {formatDate(tx.date)}
                        </td>
                        <td className="max-w-[200px] truncate py-3 pr-4 font-medium">
                          {tx.description}
                        </td>
                        <td className="py-3 pr-4 text-right font-medium">
                          {formatCurrency(tx.amount)}
                        </td>
                        <td className="py-3 pr-4">
                          {editingId === tx.id ? (
                            renderCategorySelect(true)
                          ) : tx.category ? (
                            <Badge color={tx.category.color}>
                              {tx.category.name}
                            </Badge>
                          ) : (
                            <span className="text-xs text-gray-400">未分類</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                            {sourceLabel(tx.source)}
                          </span>
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-1">
                            {editingId === tx.id ? (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => saveEdit(tx.id)}
                                >
                                  <Check className="h-4 w-4 text-green-600" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setEditingId(null)}
                                >
                                  <X className="h-4 w-4 text-gray-400" />
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => startEdit(tx)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => deleteTransaction(tx.id)}
                                >
                                  <Trash2 className="h-4 w-4 text-red-400" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* スマホ: カード */}
              <div className="space-y-3 md:hidden">
                {transactions.map((tx) => (
                  <div
                    key={tx.id}
                    className={`rounded-xl border bg-white p-4 ${
                      selectedIds.has(tx.id)
                        ? "border-indigo-300 bg-indigo-50/30"
                        : "border-gray-200"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5 rounded border-gray-300"
                        checked={selectedIds.has(tx.id)}
                        onChange={() => toggleSelect(tx.id)}
                        aria-label={`${tx.description} を選択`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-gray-500">
                              {formatDate(tx.date)}
                            </p>
                            <p className="mt-1 truncate text-base font-medium text-gray-900">
                              {tx.description}
                            </p>
                          </div>
                          <p className="flex-shrink-0 text-base font-bold text-gray-900">
                            {formatCurrency(tx.amount)}
                          </p>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-600">
                            {sourceLabel(tx.source)}
                          </span>
                          {editingId !== tx.id &&
                            (tx.category ? (
                              <Badge color={tx.category.color}>
                                {tx.category.name}
                              </Badge>
                            ) : (
                              <span className="text-xs text-gray-400">未分類</span>
                            ))}
                        </div>

                        {editingId === tx.id ? (
                          <div className="mt-3 space-y-3">
                            {renderCategorySelect(false)}
                            <div className="flex gap-2">
                              <Button
                                className="flex-1"
                                onClick={() => saveEdit(tx.id)}
                              >
                                <Check className="h-4 w-4" />
                                保存
                              </Button>
                              <Button
                                variant="outline"
                                className="flex-1"
                                onClick={() => setEditingId(null)}
                              >
                                キャンセル
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-3 flex gap-2">
                            <Button
                              variant="outline"
                              className="flex-1"
                              onClick={() => startEdit(tx)}
                            >
                              <Pencil className="h-4 w-4" />
                              カテゴリ変更
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => deleteTransaction(tx.id)}
                              aria-label="削除"
                            >
                              <Trash2 className="h-4 w-4 text-red-400" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 確認ダイアログ */}
      {confirmDialog && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
          >
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-red-100 p-2">
                <AlertTriangle className="h-5 w-5 text-red-600" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-gray-900">
                  {confirmTitle}
                </h2>
                <p className="mt-2 text-sm text-gray-600">{confirmMessage}</p>
                <p className="mt-2 text-sm font-semibold text-red-600">
                  削除件数: {confirmDialog.count}件
                </p>
              </div>
            </div>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                onClick={() => setConfirmDialog(null)}
                disabled={deleting}
              >
                キャンセル
              </Button>
              <Button
                variant="destructive"
                onClick={executeBulkDelete}
                disabled={deleting}
              >
                {deleting ? "削除中..." : "削除する"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
