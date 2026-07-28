"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, getMonthKey } from "@/lib/utils";
import type { Transaction, Category } from "@/types";
import { Pencil, Trash2, Check, X, ChevronLeft, ChevronRight } from "lucide-react";

function sourceLabel(source: Transaction["source"]) {
  if (source === "CSV") return "CSV";
  if (source === "IMAGE") return "画像";
  return "手入力";
}

export default function TransactionsPage() {
  const [currentMonth, setCurrentMonth] = useState(getMonthKey(new Date()));
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategoryId, setEditCategoryId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [txRes, catRes] = await Promise.all([
        fetch(`/api/transactions?month=${currentMonth}`),
        fetch("/api/categories"),
      ]);
      if (txRes.ok) setTransactions(await txRes.json());
      if (catRes.ok) setCategories(await catRes.json());
    } finally {
      setLoading(false);
    }
  }, [currentMonth]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

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
            {`${currentMonth.split("-")[0]}年${parseInt(currentMonth.split("-")[1])}月`}
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

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>取引一覧（{transactions.length}件）</CardTitle>
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
              この月の取引はありません
            </div>
          ) : (
            <>
              {/* PC: テーブル */}
              <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-gray-500">
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
                      <tr key={tx.id} className="hover:bg-gray-50">
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
                    className="rounded-xl border border-gray-200 bg-white p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-500">{formatDate(tx.date)}</p>
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
                          <Badge color={tx.category.color}>{tx.category.name}</Badge>
                        ) : (
                          <span className="text-xs text-gray-400">未分類</span>
                        ))}
                    </div>

                    {editingId === tx.id ? (
                      <div className="mt-3 space-y-3">
                        {renderCategorySelect(false)}
                        <div className="flex gap-2">
                          <Button className="flex-1" onClick={() => saveEdit(tx.id)}>
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
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
