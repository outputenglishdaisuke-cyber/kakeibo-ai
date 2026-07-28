"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Category } from "@/types";
import { Pencil, Trash2, Plus, Check, X } from "lucide-react";

const PRESET_COLORS = [
  "#6366f1", "#ec4899", "#f59e0b", "#10b981",
  "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6",
  "#f97316", "#84cc16", "#06b6d4", "#94a3b8",
];

interface CategoryWithCount extends Category {
  _count?: { transactions: number };
}

export default function CategoriesPage() {
  const [categories, setCategories] = useState<CategoryWithCount[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", color: PRESET_COLORS[0] });
  const [editForm, setEditForm] = useState({ name: "", color: "" });
  const [loading, setLoading] = useState(true);

  const fetchCategories = async () => {
    setLoading(true);
    const res = await fetch("/api/categories");
    if (res.ok) setCategories(await res.json());
    setLoading(false);
  };

  useEffect(() => { fetchCategories(); }, []);

  const createCategory = async () => {
    if (!form.name.trim()) return;
    await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setForm({ name: "", color: PRESET_COLORS[0] });
    fetchCategories();
  };

  const startEdit = (cat: CategoryWithCount) => {
    setEditingId(cat.id);
    setEditForm({ name: cat.name, color: cat.color });
  };

  const saveEdit = async (id: string) => {
    await fetch(`/api/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editForm),
    });
    setEditingId(null);
    fetchCategories();
  };

  const deleteCategory = async (id: string) => {
    if (!confirm("カテゴリを削除すると、紐づく取引は未分類になります。続けますか？")) return;
    await fetch(`/api/categories/${id}`, { method: "DELETE" });
    fetchCategories();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">カテゴリ管理</h1>

      {/* 新規追加フォーム */}
      <Card>
        <CardHeader>
          <CardTitle>新しいカテゴリを追加</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">カテゴリ名</label>
              <input
                type="text"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="例: 食費"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">カラー</label>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setForm((p) => ({ ...p, color: c }))}
                    className={`h-6 w-6 rounded-full transition-transform ${
                      form.color === c ? "ring-2 ring-offset-1 ring-gray-400 scale-110" : ""
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
            <Button onClick={createCategory} disabled={!form.name.trim()}>
              <Plus className="h-4 w-4" />
              追加
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* カテゴリ一覧 */}
      <Card>
        <CardHeader>
          <CardTitle>カテゴリ一覧</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center text-gray-400">読み込み中...</div>
          ) : categories.length === 0 ? (
            <div className="py-8 text-center text-gray-400">カテゴリがありません</div>
          ) : (
            <div className="space-y-2">
              {categories.map((cat) => (
                <div
                  key={cat.id}
                  className="flex items-center gap-4 rounded-lg border border-gray-100 px-4 py-3 hover:bg-gray-50"
                >
                  {editingId === cat.id ? (
                    <>
                      <input
                        type="text"
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                        value={editForm.name}
                        onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                      />
                      <div className="flex gap-1.5">
                        {PRESET_COLORS.map((c) => (
                          <button
                            key={c}
                            onClick={() => setEditForm((p) => ({ ...p, color: c }))}
                            className={`h-5 w-5 rounded-full transition-transform ${
                              editForm.color === c ? "ring-2 ring-offset-1 ring-gray-400 scale-110" : ""
                            }`}
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => saveEdit(cat.id)}>
                        <Check className="h-4 w-4 text-green-600" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setEditingId(null)}>
                        <X className="h-4 w-4 text-gray-400" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <div
                        className="h-4 w-4 rounded-full flex-shrink-0"
                        style={{ backgroundColor: cat.color }}
                      />
                      <span className="flex-1 text-sm font-medium">{cat.name}</span>
                      <span className="text-xs text-gray-400">
                        {cat._count?.transactions ?? 0}件
                      </span>
                      <Button variant="ghost" size="icon" onClick={() => startEdit(cat)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => deleteCategory(cat.id)}>
                        <Trash2 className="h-4 w-4 text-red-400" />
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
