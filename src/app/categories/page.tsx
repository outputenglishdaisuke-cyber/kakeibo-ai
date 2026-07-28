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

  const colorPicker = (
    selected: string,
    onSelect: (c: string) => void,
    size: "sm" | "md" = "md"
  ) => (
    <div className="flex flex-wrap gap-2">
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onSelect(c)}
          aria-label={`色 ${c}`}
          className={`${
            size === "md" ? "h-8 w-8 md:h-6 md:w-6" : "h-8 w-8 md:h-5 md:w-5"
          } rounded-full transition-transform ${
            selected === c ? "scale-110 ring-2 ring-gray-400 ring-offset-1" : ""
          }`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">カテゴリ管理</h1>

      <Card>
        <CardHeader>
          <CardTitle>新しいカテゴリを追加</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end">
            <div className="w-full md:w-auto">
              <label className="mb-1 block text-xs font-medium text-gray-700">カテゴリ名</label>
              <input
                type="text"
                className="h-11 w-full rounded-lg border border-gray-300 px-3 text-base focus:border-indigo-500 focus:outline-none md:h-auto md:w-auto md:py-2 md:text-sm"
                placeholder="例: 食費"
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="w-full md:w-auto">
              <label className="mb-1 block text-xs font-medium text-gray-700">カラー</label>
              {colorPicker(form.color, (c) => setForm((p) => ({ ...p, color: c })))}
            </div>
            <Button
              className="w-full md:w-auto"
              onClick={createCategory}
              disabled={!form.name.trim()}
            >
              <Plus className="h-4 w-4" />
              追加
            </Button>
          </div>
        </CardContent>
      </Card>

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
            <div className="space-y-3">
              {categories.map((cat) => (
                <div
                  key={cat.id}
                  className="rounded-xl border border-gray-100 p-4 md:flex md:items-center md:gap-4 md:rounded-lg md:px-4 md:py-3 md:hover:bg-gray-50"
                >
                  {editingId === cat.id ? (
                    <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:gap-4">
                      <input
                        type="text"
                        className="h-11 w-full rounded-lg border border-gray-300 px-3 text-base focus:border-indigo-500 focus:outline-none md:h-auto md:flex-1 md:py-1.5 md:text-sm"
                        value={editForm.name}
                        onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                      />
                      {colorPicker(
                        editForm.color,
                        (c) => setEditForm((p) => ({ ...p, color: c })),
                        "sm"
                      )}
                      <div className="flex gap-2">
                        <Button
                          className="flex-1 md:flex-none"
                          variant="outline"
                          onClick={() => saveEdit(cat.id)}
                        >
                          <Check className="h-4 w-4 text-green-600" />
                          <span className="md:hidden">保存</span>
                        </Button>
                        <Button
                          className="flex-1 md:flex-none"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-4 w-4 text-gray-400" />
                          <span className="md:hidden">取消</span>
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:gap-4">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div
                          className="h-4 w-4 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: cat.color }}
                        />
                        <span className="truncate text-base font-medium md:text-sm">
                          {cat.name}
                        </span>
                        <span className="text-xs text-gray-400">
                          {cat._count?.transactions ?? 0}件
                        </span>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          className="flex-1 md:flex-none"
                          onClick={() => startEdit(cat)}
                        >
                          <Pencil className="h-4 w-4" />
                          <span className="md:hidden">編集</span>
                        </Button>
                        <Button
                          variant="ghost"
                          className="flex-1 md:flex-none"
                          onClick={() => deleteCategory(cat.id)}
                        >
                          <Trash2 className="h-4 w-4 text-red-400" />
                          <span className="md:hidden">削除</span>
                        </Button>
                      </div>
                    </div>
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
