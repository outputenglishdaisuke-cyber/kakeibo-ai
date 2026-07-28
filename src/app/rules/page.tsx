"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Rule, Category } from "@/types";
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [form, setForm] = useState({ keyword: "", categoryId: "", priority: 0 });
  const [loading, setLoading] = useState(true);

  const fetchAll = async () => {
    setLoading(true);
    const [rRes, cRes] = await Promise.all([
      fetch("/api/rules"),
      fetch("/api/categories"),
    ]);
    if (rRes.ok) setRules(await rRes.json());
    if (cRes.ok) setCategories(await cRes.json());
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  const createRule = async () => {
    if (!form.keyword.trim() || !form.categoryId) return;
    await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setForm({ keyword: "", categoryId: "", priority: 0 });
    fetchAll();
  };

  const deleteRule = async (id: string) => {
    await fetch(`/api/rules/${id}`, { method: "DELETE" });
    fetchAll();
  };

  const changePriority = async (id: string, delta: number) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) return;
    await fetch(`/api/rules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: rule.priority + delta }),
    });
    fetchAll();
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">ルール管理</h1>
      <p className="text-sm text-gray-500">
        キーワードが利用先名に含まれる場合、自動的に指定カテゴリに分類されます。
        優先度が高いルールが先に適用されます。
      </p>

      {/* 新規追加フォーム */}
      <Card>
        <CardHeader>
          <CardTitle>新しいルールを追加</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">キーワード</label>
              <input
                type="text"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="例: スターバックス"
                value={form.keyword}
                onChange={(e) => setForm((p) => ({ ...p, keyword: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">分類先カテゴリ</label>
              <select
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                value={form.categoryId}
                onChange={(e) => setForm((p) => ({ ...p, categoryId: e.target.value }))}
              >
                <option value="">カテゴリを選択</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">優先度</label>
              <input
                type="number"
                className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                value={form.priority}
                onChange={(e) => setForm((p) => ({ ...p, priority: parseInt(e.target.value, 10) || 0 }))}
              />
            </div>
            <Button onClick={createRule} disabled={!form.keyword.trim() || !form.categoryId}>
              <Plus className="h-4 w-4" />
              追加
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ルール一覧 */}
      <Card>
        <CardHeader>
          <CardTitle>ルール一覧（優先度順）</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-8 text-center text-gray-400">読み込み中...</div>
          ) : rules.length === 0 ? (
            <div className="py-8 text-center text-gray-400">ルールがありません</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="pb-3 pr-4 font-medium">優先度</th>
                    <th className="pb-3 pr-4 font-medium">キーワード</th>
                    <th className="pb-3 pr-4 font-medium">分類先</th>
                    <th className="pb-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rules.map((rule) => (
                    <tr key={rule.id} className="hover:bg-gray-50">
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-1">
                          <span className="w-8 text-center text-gray-600">{rule.priority}</span>
                          <div className="flex flex-col">
                            <button
                              onClick={() => changePriority(rule.id, 1)}
                              className="text-gray-400 hover:text-gray-600"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => changePriority(rule.id, -1)}
                              className="text-gray-400 hover:text-gray-600"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-4 font-mono text-gray-800">
                        {rule.keyword}
                      </td>
                      <td className="py-3 pr-4">
                        {rule.category && (
                          <Badge color={rule.category.color}>
                            {rule.category.name}
                          </Badge>
                        )}
                      </td>
                      <td className="py-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteRule(rule.id)}
                        >
                          <Trash2 className="h-4 w-4 text-red-400" />
                        </Button>
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
