"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { ParsedTransaction } from "@/types";
import { Upload, FileText, Camera, PenLine, Check, AlertCircle } from "lucide-react";

type TabType = "csv" | "manual" | "image";

interface ParseResult {
  transactions: ParsedTransaction[];
  mapping?: { date: string; description: string; amount: string };
}

export default function ImportPage() {
  const [tab, setTab] = useState<TabType>("csv");
  const [parsed, setParsed] = useState<ParsedTransaction[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // CSV アップロード
  const [csvFile, setCsvFile] = useState<File | null>(null);

  // 手入力フォーム
  const [manualForm, setManualForm] = useState({
    date: new Date().toISOString().split("T")[0],
    description: "",
    amount: "",
  });

  // 画像アップロード
  const [imageFile, setImageFile] = useState<File | null>(null);

  const handleCsvUpload = async () => {
    if (!csvFile) return;
    setLoading(true);
    setMessage(null);
    try {
      const fd = new FormData();
      fd.append("file", csvFile);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json();
        setMessage({ type: "error", text: err.error ?? "エラーが発生しました" });
        return;
      }
      const data: ParseResult = await res.json();
      setParsed(data.transactions);
    } catch {
      setMessage({ type: "error", text: "CSV の解析に失敗しました" });
    } finally {
      setLoading(false);
    }
  };

  const handleImageUpload = async () => {
    if (!imageFile) return;
    setLoading(true);
    setMessage(null);
    try {
      const fd = new FormData();
      fd.append("file", imageFile);
      const res = await fetch("/api/import/image", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json();
        setMessage({ type: "error", text: err.error ?? "エラーが発生しました" });
        return;
      }
      const data = await res.json();
      setParsed(data.transactions);
    } catch {
      setMessage({ type: "error", text: "画像の解析に失敗しました" });
    } finally {
      setLoading(false);
    }
  };

  const handleManualAdd = () => {
    if (!manualForm.description || !manualForm.amount) return;
    const tx: ParsedTransaction = {
      date: manualForm.date,
      description: manualForm.description,
      amount: parseInt(manualForm.amount, 10),
      source: "MANUAL",
    };
    setParsed((prev) => [...(prev ?? []), tx]);
    setManualForm({ date: new Date().toISOString().split("T")[0], description: "", amount: "" });
  };

  const removeItem = (index: number) => {
    setParsed((prev) => prev?.filter((_, i) => i !== index) ?? null);
  };

  const confirmAndSave = async () => {
    if (!parsed || parsed.length === 0) return;
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
      setMessage({ type: "success", text: `${data.count}件の取引を保存しました` });
      setParsed(null);
      setCsvFile(null);
      setImageFile(null);
    } finally {
      setSaving(false);
    }
  };

  const tabs: { key: TabType; label: string; icon: React.ReactNode }[] = [
    { key: "csv", label: "CSV", icon: <FileText className="h-4 w-4" /> },
    { key: "manual", label: "手入力", icon: <PenLine className="h-4 w-4" /> },
    { key: "image", label: "画像", icon: <Camera className="h-4 w-4" /> },
  ];

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
            <Check className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          {message.text}
        </div>
      )}

      {/* タブ */}
      <div className="flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1 w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setParsed(null); }}
            className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
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
            {tab === "csv" && "CSV ファイルをアップロード"}
            {tab === "manual" && "手動で支出を入力"}
            {tab === "image" && "利用明細の画像をアップロード"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* CSV タブ */}
          {tab === "csv" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                カード会社のCSVをアップロードすると、AIが列を自動認識して支出を抽出します。
              </p>
              <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 p-10 hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors">
                <Upload className="h-8 w-8 text-gray-400" />
                <span className="text-sm text-gray-500">
                  {csvFile ? csvFile.name : "CSV ファイルをクリックまたはドロップ"}
                </span>
                <input
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <Button
                onClick={handleCsvUpload}
                disabled={!csvFile || loading}
                className="w-full"
              >
                {loading ? "解析中..." : "CSV を解析する"}
              </Button>
            </div>
          )}

          {/* 手入力タブ */}
          {tab === "manual" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">日付</label>
                  <input
                    type="date"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    value={manualForm.date}
                    onChange={(e) => setManualForm((p) => ({ ...p, date: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">利用先</label>
                  <input
                    type="text"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="例: スターバックス"
                    value={manualForm.description}
                    onChange={(e) => setManualForm((p) => ({ ...p, description: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">金額（円）</label>
                  <input
                    type="number"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                    placeholder="例: 500"
                    value={manualForm.amount}
                    onChange={(e) => setManualForm((p) => ({ ...p, amount: e.target.value }))}
                  />
                </div>
              </div>
              <Button onClick={handleManualAdd} disabled={!manualForm.description || !manualForm.amount}>
                リストに追加
              </Button>
            </div>
          )}

          {/* 画像タブ */}
          {tab === "image" && (
            <div className="space-y-4">
              <p className="text-sm text-gray-500">
                クレジットカードや銀行の利用明細画像をアップロードすると、AI が OCR で取引を抽出します。
              </p>
              <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 p-10 hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors">
                <Camera className="h-8 w-8 text-gray-400" />
                <span className="text-sm text-gray-500">
                  {imageFile ? imageFile.name : "JPEG / PNG 画像をクリックまたはドロップ"}
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => setImageFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <Button
                onClick={handleImageUpload}
                disabled={!imageFile || loading}
                className="w-full"
              >
                {loading ? "画像を解析中..." : "画像から取引を抽出する"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* プレビュー・確認画面 */}
      {parsed && parsed.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>
                取り込み内容の確認（{parsed.length}件）
              </CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setParsed(null)}>
                  キャンセル
                </Button>
                <Button onClick={confirmAndSave} disabled={saving}>
                  {saving ? "保存中..." : `${parsed.length}件を保存する`}
                </Button>
              </div>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              内容を確認してから「保存する」を押してください。AI が自動的にカテゴリを分類します。
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-500">
                    <th className="pb-3 pr-4 font-medium">日付</th>
                    <th className="pb-3 pr-4 font-medium">利用先</th>
                    <th className="pb-3 pr-4 font-medium">金額</th>
                    <th className="pb-3 font-medium">削除</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {parsed.map((tx, i) => (
                    <tr key={i} className="hover:bg-gray-50">
                      <td className="py-3 pr-4 text-gray-600">{formatDate(tx.date)}</td>
                      <td className="py-3 pr-4 font-medium">{tx.description}</td>
                      <td className="py-3 pr-4 text-right">{formatCurrency(tx.amount)}</td>
                      <td className="py-3">
                        <button
                          onClick={() => removeItem(i)}
                          className="text-red-400 hover:text-red-600 text-xs"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
