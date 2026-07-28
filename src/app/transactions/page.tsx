"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDate, getMonthKey } from "@/lib/utils";
import type { Transaction, Category } from "@/types";
import { Pencil, Trash2, Check, X, ChevronLeft, ChevronRight } from "lucide-react";

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">明細一覧</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => changeMonth(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[90px] text-center font-medium text-sm">
            {`${currentMonth.split("-")[0]}年${parseInt(currentMonth.split("-")[1])}月`}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => changeMonth(1)}
            disabled={currentMonth >= getMonthKey(new Date())}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
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
            <div className="overflow-x-auto">
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
                      <td className="py-3 pr-4 font-medium max-w-[200px] truncate">
                        {tx.description}
                      </td>
                      <td className="py-3 pr-4 text-right font-medium">
                        {formatCurrency(tx.amount)}
                      </td>
                      <td className="py-3 pr-4">
                        {editingId === tx.id ? (
                          <select
                            className="rounded border border-gray-300 px-2 py-1 text-sm"
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
                        ) : tx.category ? (
                          <Badge color={tx.category.color}>
                            {tx.category.name}
                          </Badge>
                        ) : (
                          <span className="text-gray-400 text-xs">未分類</span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                          {tx.source === "CSV"
                            ? "CSV"
                            : tx.source === "IMAGE"
                            ? "画像"
                            : "手入力"}
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
