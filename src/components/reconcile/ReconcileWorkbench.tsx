"use client";

import { useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronRight, Plus, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategorySelect } from "@/components/ui/category-select";
import { cn, formatCurrency } from "@/lib/utils";
import { pickBulkTopExact, type RankedCandidate } from "@/lib/manual-reconcile";
import type { OperationRequest } from "@/lib/manual-reconcile-service";
import type { ReconcileView } from "@/lib/reconcile-service";
import type { Category } from "@/types";

type ReceiptItem = ReconcileView["unmatchedReceipts"][number];
type CardItem = ReconcileView["unmatchedCards"][number];
type Item = ReceiptItem | CardItem;
type OpResult =
  | { ok: true; opId: string; summary: string }
  | { ok: false; code: "conflict" | "invalid" | "error"; error: string };

type Tab = "open" | "autoCash" | "settled" | "history";
type Filter = "all" | "receipt" | "card";
type Sort = "amountDesc" | "dateDesc" | "dateAsc";

const keyOf = (item: Item) => `${item.kind}:${item.id}`;
const BULK_CHUNK = 5;

function shortDate(date: string) {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function signedYen(n: number) {
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${formatCurrency(Math.abs(n))}`;
}

async function postOperations(operations: OperationRequest[]): Promise<OpResult[]> {
  const res = await fetch("/api/reconcile/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operations }),
  });
  const json = await res.json().catch(() => null);
  if (json && Array.isArray(json.results)) return json.results;
  return operations.map(() => ({
    ok: false as const,
    code: "error" as const,
    error: typeof json?.error === "string" ? json.error : "操作に失敗しました（変更は保存されていません）",
  }));
}

export function ReconcileWorkbench({
  data,
  categories,
  onChanged,
}: {
  data: ReconcileView;
  categories: Category[];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("open");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("amountDesc");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "error"; undoOpId?: string } | null>(
    null
  );
  const [bulk, setBulk] = useState<BulkPlan | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const categoryName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);

  const openItems: Item[] = useMemo(
    () => [...data.unmatchedReceipts, ...data.unmatchedCards],
    [data.unmatchedReceipts, data.unmatchedCards]
  );
  const allItems: Item[] = useMemo(
    () => [...openItems, ...data.autoCashReceipts],
    [openItems, data.autoCashReceipts]
  );
  const itemByKey = useMemo(() => new Map(allItems.map((i) => [keyOf(i), i])), [allItems]);
  const active = activeKey ? itemByKey.get(activeKey) ?? null : null;

  const listed = useMemo(() => {
    const base =
      tab === "autoCash"
        ? (data.autoCashReceipts as Item[])
        : openItems.filter((i) => filter === "all" || i.kind === filter);
    const sorted = [...base];
    sorted.sort((a, b) =>
      sort === "amountDesc"
        ? b.amount - a.amount || a.date.localeCompare(b.date)
        : sort === "dateDesc"
          ? b.date.localeCompare(a.date) || b.amount - a.amount
          : a.date.localeCompare(b.date) || b.amount - a.amount
    );
    return sorted;
  }, [tab, filter, sort, openItems, data.autoCashReceipts]);

  const openTotal = openItems.reduce((s, i) => s + i.amount, 0);
  const receiptOpen = data.unmatchedReceipts;
  const cardOpen = data.unmatchedCards;

  const selectedItems = [...selected].map((k) => itemByKey.get(k)).filter((i): i is Item => !!i);

  const run = async (operations: OperationRequest[], options: { closeSheet?: boolean } = {}) => {
    setBusy(true);
    setNotice(null);
    try {
      const results = await postOperations(operations);
      const failed = results.filter((r) => !r.ok);
      const ok = results.filter((r): r is Extract<OpResult, { ok: true }> => r.ok);
      if (failed.length === 0) {
        const last = ok.at(-1);
        setNotice({ text: last?.summary ?? "完了しました", tone: "info", undoOpId: last?.opId });
        if (options.closeSheet !== false) setActiveKey(null);
      } else {
        const first = failed[0] as Extract<OpResult, { ok: false }>;
        setNotice({
          text:
            first.code === "conflict"
              ? `${first.error}（最新の状態を読み込みました）`
              : first.error,
          tone: "error",
        });
        if (first.code === "conflict") setActiveKey(null);
      }
      onChanged();
      return results;
    } finally {
      setBusy(false);
    }
  };

  const undo = (opId: string) => run([{ kind: "undo", opId }]);

  const toggleSelect = (item: Item) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(item);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const linkOperation = (
    item: Item,
    candidateIds: string[],
    diffMode: "tax" | "other" | null
  ): OperationRequest => {
    const expected: Record<string, string> = { [item.id]: item.version };
    for (const id of candidateIds) {
      const v = data.versions[id];
      if (v) expected[id] = v;
    }
    return item.kind === "receipt"
      ? { kind: "link", cardIds: candidateIds, receiptIds: [item.id], diffMode, expected }
      : { kind: "link", cardIds: [item.id], receiptIds: candidateIds, diffMode, expected };
  };

  const prepareBulk = (action: BulkAction) => {
    const items = tab === "autoCash" ? selectedItems.filter((i) => i.kind === "receipt") : selectedItems;
    if (action === "topExact") {
      const { targets, skipped } = pickBulkTopExact(items);
      setBulk({
        action,
        targets: targets.map((t) => ({ item: t.item, candidateId: t.candidateId })),
        skipped: skipped.map((s) => ({ item: s.item, reason: s.reason })),
      });
    } else if (action === "cash") {
      setBulk({
        action,
        targets: items.filter((i) => i.kind === "receipt").map((item) => ({ item })),
        skipped: items.filter((i) => i.kind !== "receipt").map((item) => ({ item, reason: "カード明細" })),
      });
    } else {
      setBulk({
        action,
        targets: items.filter((i) => i.kind === "card").map((item) => ({ item })),
        skipped: items.filter((i) => i.kind !== "card").map((item) => ({ item, reason: "レシート" })),
      });
    }
  };

  const executeBulk = async (plan: BulkPlan, categoryId: string | null) => {
    const ops: OperationRequest[] = plan.targets.map(({ item, candidateId }) => {
      if (plan.action === "topExact") return linkOperation(item, [candidateId!], null);
      if (plan.action === "cash") return { kind: "cash", receiptId: item.id, expected: { [item.id]: item.version } };
      return {
        kind: "card_only",
        cardId: item.id,
        parts: [{ categoryId: categoryId!, amount: item.amount }],
        expected: { [item.id]: item.version },
      };
    });
    setBulk(null);
    setBusy(true);
    setNotice(null);
    setProgress({ done: 0, total: ops.length });
    const results: OpResult[] = [];
    try {
      for (let i = 0; i < ops.length; i += BULK_CHUNK) {
        results.push(...(await postOperations(ops.slice(i, i + BULK_CHUNK))));
        setProgress({ done: Math.min(i + BULK_CHUNK, ops.length), total: ops.length });
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r): r is Extract<OpResult, { ok: false }> => !r.ok);
    setNotice({
      text:
        failed.length === 0
          ? `${okCount}件を処理しました（取り消しは「履歴」から1件ずつ行えます）`
          : `${okCount}件を処理し、${failed.length}件は失敗しました（${failed[0].error}）`,
      tone: failed.length === 0 ? "info" : "error",
    });
    setSelected(new Set());
    onChanged();
  };

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "open", label: "未消込", count: openItems.length },
    { id: "autoCash", label: "自動現金", count: data.autoCashReceipts.length },
    {
      id: "settled",
      label: "確定済み",
      count:
        data.matchedPairs.length +
        data.cashConfirmed.length +
        data.cardOnlySettled.length +
        data.duplicatesExcluded.length,
    },
    { id: "history", label: "履歴", count: data.operations.length },
  ];

  return (
    <Card className="min-w-0">
      <CardHeader className="space-y-3 pb-3">
        <CardTitle className="text-base">未消込の決着</CardTitle>
        <div className="grid grid-cols-3 gap-2" data-testid="open-stats">
          <div className="min-w-0 rounded-lg bg-rose-50 px-3 py-2">
            <p className="truncate text-xs text-rose-700">未消込</p>
            <p className="truncate text-base font-semibold tabular-nums text-rose-900">
              {openItems.length}件
            </p>
            <p className="truncate text-xs tabular-nums text-rose-700">{formatCurrency(openTotal)}</p>
          </div>
          <div className="min-w-0 rounded-lg bg-gray-50 px-3 py-2">
            <p className="truncate text-xs text-gray-500">レシート</p>
            <p className="truncate text-base font-semibold tabular-nums">{receiptOpen.length}件</p>
            <p className="truncate text-xs tabular-nums text-gray-500">
              {formatCurrency(receiptOpen.reduce((s, i) => s + i.amount, 0))}
            </p>
          </div>
          <div className="min-w-0 rounded-lg bg-gray-50 px-3 py-2">
            <p className="truncate text-xs text-gray-500">カード明細</p>
            <p className="truncate text-base font-semibold tabular-nums">{cardOpen.length}件</p>
            <p className="truncate text-xs tabular-nums text-gray-500">
              {formatCurrency(cardOpen.reduce((s, i) => s + i.amount, 0))}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1 rounded-lg bg-gray-100 p-1" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={cn(
                "min-h-11 min-w-0 rounded-md px-1 text-xs font-medium md:min-h-9 md:text-sm",
                tab === t.id ? "bg-white text-gray-900 shadow-sm" : "text-gray-600"
              )}
              onClick={() => {
                setTab(t.id);
                setSelected(new Set());
              }}
            >
              <span className="block truncate">{t.label}</span>
              <span className="block text-[11px] tabular-nums text-gray-500">{t.count}</span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {notice ? (
          <div
            role="status"
            className={cn(
              "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
              notice.tone === "error" ? "bg-red-50 text-red-700" : "bg-indigo-50 text-indigo-800"
            )}
          >
            <p className="min-w-0 flex-1 break-words">{notice.text}</p>
            {notice.undoOpId ? (
              <Button
                variant="outline"
                size="sm"
                className="h-9 flex-shrink-0"
                disabled={busy}
                onClick={() => undo(notice.undoOpId!)}
              >
                <Undo2 className="h-4 w-4" />
                取り消す
              </Button>
            ) : null}
          </div>
        ) : null}
        {progress ? (
          <div className="space-y-1" aria-live="polite">
            <p className="text-xs text-gray-600">
              処理中… {progress.done} / {progress.total}件
            </p>
            <div className="h-2 overflow-hidden rounded bg-gray-100">
              <div
                className="h-full bg-indigo-500 transition-all"
                style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
              />
            </div>
          </div>
        ) : null}

        {tab === "open" || tab === "autoCash" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {tab === "open" ? (
                <div className="flex gap-1">
                  {(
                    [
                      ["all", "すべて"],
                      ["receipt", "レシート"],
                      ["card", "カード"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      className={cn(
                        "h-9 rounded-full border px-3 text-xs",
                        filter === id
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : "border-gray-300 bg-white text-gray-700"
                      )}
                      onClick={() => setFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500">
                  カード決済だったものが紛れていないか確認し、現金で確定するか、カード明細に紐付けてください。
                </p>
              )}
              <select
                aria-label="並び順"
                className="ml-auto h-9 rounded border border-gray-300 bg-white px-2 text-sm"
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
              >
                <option value="amountDesc">金額の大きい順</option>
                <option value="dateDesc">日付の新しい順</option>
                <option value="dateAsc">日付の古い順</option>
              </select>
            </div>

            {listed.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">
                {tab === "open" ? "未消込はありません" : "自動で現金にしたレシートはありません"}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100" data-testid="open-list">
                {listed.map((item) => (
                  <ItemRow
                    key={keyOf(item)}
                    item={item}
                    checked={selected.has(keyOf(item))}
                    onToggle={() => toggleSelect(item)}
                    onOpen={() => setActiveKey(keyOf(item))}
                  />
                ))}
              </ul>
            )}

            {selectedItems.length > 0 ? (
              <div className="sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 space-y-2 rounded-xl border border-indigo-200 bg-white p-3 shadow-lg md:bottom-4">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span>
                    {selectedItems.length}件を選択（
                    {formatCurrency(selectedItems.reduce((s, i) => s + i.amount, 0))}）
                  </span>
                  <button className="h-9 px-2 text-xs text-gray-500" onClick={() => setSelected(new Set())}>
                    選択を解除
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Button disabled={busy} onClick={() => prepareBulk("topExact")}>
                    候補1番を一括採用
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !selectedItems.some((i) => i.kind === "receipt")}
                    onClick={() => prepareBulk("cash")}
                  >
                    まとめて現金確定
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !selectedItems.some((i) => i.kind === "card")}
                    onClick={() => prepareBulk("category")}
                  >
                    まとめてカテゴリ確定
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "settled" ? (
          <SettledLists data={data} categoryName={categoryName} busy={busy} run={run} undo={undo} />
        ) : null}
        {tab === "history" ? <HistoryList data={data} busy={busy} undo={undo} /> : null}
      </CardContent>

      <Sheet open={!!active} onClose={() => setActiveKey(null)} title={active ? active.storeName : ""}>
        {active ? (
          active.kind === "receipt" ? (
            <ReceiptPanel
              key={keyOf(active)}
              item={active}
              busy={busy}
              run={run}
              linkOperation={linkOperation}
            />
          ) : (
            <CardPanel
              key={keyOf(active)}
              item={active}
              categories={categories}
              busy={busy}
              run={run}
              linkOperation={linkOperation}
            />
          )
        ) : null}
      </Sheet>

      <BulkConfirm
        plan={bulk}
        categories={categories}
        onCancel={() => setBulk(null)}
        onExecute={executeBulk}
      />
    </Card>
  );
}

function ItemRow({
  item,
  checked,
  onToggle,
  onOpen,
}: {
  item: Item;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const top = item.candidates[0];
  return (
    <li className="flex items-stretch gap-1">
      <label className="flex w-11 flex-shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          className="h-5 w-5 accent-indigo-600"
          checked={checked}
          onChange={onToggle}
          aria-label={`${item.storeName} を選択`}
        />
      </label>
      <button
        className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left"
        onClick={onOpen}
        data-testid="open-row"
      >
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-gray-900">
            <span
              className={cn(
                "flex-shrink-0 rounded px-1 text-[11px]",
                item.kind === "receipt" ? "bg-sky-100 text-sky-800" : "bg-orange-100 text-orange-800"
              )}
            >
              {item.kind === "receipt" ? (item.autoCash ? "自動現金" : "レシート") : "カード"}
            </span>
            <span className="truncate">{item.storeName}</span>
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-gray-500">
            <span>{shortDate(item.date)}</span>
            {item.kind === "receipt" && item.rowCount > 1 ? <span>品目{item.rowCount}行</span> : null}
            {item.kind === "receipt" && item.reason === "no_csv_coverage" ? (
              <span className="rounded bg-gray-100 px-1 text-gray-600">CSV未取込の期間</span>
            ) : null}
            {item.noAutoCash ? (
              <span className="rounded bg-violet-100 px-1 text-violet-800">{item.noAutoCash}</span>
            ) : null}
          </p>
          {top ? (
            <p className="mt-0.5 truncate text-xs text-gray-500">
              候補: {shortDate(top.date)} {top.storeName}{" "}
              {top.exact ? (
                <span className="text-emerald-700">金額一致</span>
              ) : (
                <span className="text-amber-700">差額 {signedYen(top.adjust)}</span>
              )}
            </p>
          ) : null}
        </div>
        <span className="flex-shrink-0 text-sm font-medium tabular-nums">{formatCurrency(item.amount)}</span>
        <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-400" />
      </button>
    </li>
  );
}

function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-2xl bg-white shadow-xl outline-none",
            "md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[85vh] md:w-full md:max-w-lg md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
          )}
          aria-describedby={undefined}
          data-testid="sheet"
        >
          <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-gray-300 md:hidden" />
          <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2">
            <Dialog.Title className="min-w-0 flex-1 truncate text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="閉じる">
                <X className="h-5 w-5" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t border-gray-100 py-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      {children}
    </section>
  );
}

type Run = (ops: OperationRequest[], options?: { closeSheet?: boolean }) => Promise<OpResult[]>;
type LinkOp = (item: Item, candidateIds: string[], diffMode: "tax" | "other" | null) => OperationRequest;

/** 候補の選択と差額の扱い（レシート・カード明細の両方で使う） */
function LinkSection({
  item,
  busy,
  run,
  linkOperation,
  candidateLabel,
}: {
  item: Item;
  busy: boolean;
  run: Run;
  linkOperation: LinkOp;
  candidateLabel: string;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [diffMode, setDiffMode] = useState<"tax" | "other" | "none">("tax");
  const candidates = item.candidates;
  const pickedCandidates = candidates.filter((c) => picked.includes(c.id));
  const pickedTotal = pickedCandidates.reduce((s, c) => s + c.amount, 0);
  const diff =
    item.kind === "receipt" ? pickedTotal - item.amount : item.amount - pickedTotal;
  const effectiveMode = diff < 0 && diffMode === "tax" ? "other" : diffMode;
  const canLink = picked.length > 0 && (diff === 0 || effectiveMode !== "none");

  const toggle = (c: RankedCandidate) =>
    setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]));

  const top = candidates[0];
  const adoptTop = () => {
    if (!top) return;
    if (top.exact) {
      run([linkOperation(item, [top.id], null)]);
    } else {
      setPicked([top.id]);
    }
  };

  const link = () =>
    run([linkOperation(item, picked, diff === 0 ? null : effectiveMode === "none" ? null : effectiveMode)]);

  return (
    <PanelSection title={`${candidateLabel}に紐付ける`}>
      {candidates.length === 0 ? (
        <p className="text-sm text-gray-400">近い候補がありません</p>
      ) : (
        <>
          <Button className="w-full" disabled={busy} onClick={adoptTop} data-testid="adopt-top">
            <Check className="h-4 w-4" />
            候補1番を採用
            <span className="truncate text-xs font-normal opacity-90">
              （{top.exact ? "金額一致" : `差額 ${signedYen(top.adjust)}`}）
            </span>
          </Button>
          <p className="text-xs text-gray-500">
            {item.kind === "receipt"
              ? "複数のカード明細（例: ETCの通行ごとの明細）をまとめて1枚のレシートに紐付けるときは、複数選んでください。"
              : "複数のレシートをまとめて1件のカード明細に紐付けるときは、複数選んでください。"}
          </p>
          <ul className="space-y-1.5" data-testid="candidates">
            {candidates.map((c, i) => (
              <li key={c.id}>
                <label
                  className={cn(
                    "flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2",
                    picked.includes(c.id) ? "border-indigo-500 bg-indigo-50" : "border-gray-200"
                  )}
                >
                  <input
                    type="checkbox"
                    className="h-5 w-5 flex-shrink-0 accent-indigo-600"
                    checked={picked.includes(c.id)}
                    onChange={() => toggle(c)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      <span className="mr-1 text-xs text-gray-400">{i + 1}.</span>
                      {c.storeName}
                    </p>
                    <p className="text-xs text-gray-500">
                      {shortDate(c.date)}（{c.dateDiffDays === 0 ? "同日" : `${c.dateDiffDays > 0 ? "+" : ""}${c.dateDiffDays}日`}）
                      {c.exact ? (
                        <span className="ml-1 text-emerald-700">金額一致</span>
                      ) : (
                        <span className="ml-1 text-amber-700">差額 {signedYen(c.adjust)}</span>
                      )}
                      {c.sameStore ? <span className="ml-1 text-gray-400">同じ店</span> : null}
                    </p>
                  </div>
                  <span className="flex-shrink-0 text-sm tabular-nums">{formatCurrency(c.amount)}</span>
                </label>
              </li>
            ))}
          </ul>
          {picked.length > 0 ? (
            <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-sm" data-testid="link-summary">
              <div className="flex justify-between">
                <span>選んだ{picked.length}件の合計</span>
                <span className="tabular-nums">{formatCurrency(pickedTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>{item.kind === "receipt" ? "このレシート" : "このカード明細"}</span>
                <span className="tabular-nums">{formatCurrency(item.amount)}</span>
              </div>
              <div className={cn("flex justify-between font-medium", diff === 0 ? "text-emerald-700" : "text-amber-700")}>
                <span>差額（カード明細 − レシート）</span>
                <span className="tabular-nums">{diff === 0 ? "なし" : signedYen(diff)}</span>
              </div>
              {diff !== 0 ? (
                <fieldset className="space-y-1">
                  <legend className="text-xs text-gray-600">
                    差額の扱い（カード明細の金額を正とし、内訳の合計をカード明細に合わせます）
                  </legend>
                  {(
                    [
                      ["tax", "消費税として加える", diff < 0],
                      ["other", "その他の調整行として加える", false],
                      ["none", "紐付けない", false],
                    ] as const
                  ).map(([id, label, disabled]) => (
                    <label
                      key={id}
                      className={cn("flex min-h-10 items-center gap-2", disabled && "opacity-40")}
                    >
                      <input
                        type="radio"
                        name={`diff-${item.id}`}
                        className="h-5 w-5 accent-indigo-600"
                        disabled={disabled}
                        checked={effectiveMode === id}
                        onChange={() => setDiffMode(id)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <Button className="w-full" disabled={busy || !canLink} onClick={link} data-testid="link-submit">
                紐付ける
              </Button>
            </div>
          ) : null}
        </>
      )}
    </PanelSection>
  );
}

function ReceiptPanel({
  item,
  busy,
  run,
  linkOperation,
}: {
  item: ReceiptItem;
  busy: boolean;
  run: Run;
  linkOperation: LinkOp;
}) {
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const expected = { [item.id]: item.version };
  return (
    <div>
      <PanelHeader item={item} />
      <LinkSection item={item} busy={busy} run={run} linkOperation={linkOperation} candidateLabel="カード明細" />
      <PanelSection title="現金として確定する">
        <Button
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={() => run([{ kind: "cash", receiptId: item.id, expected }])}
          data-testid="cash-submit"
        >
          現金で確定
        </Button>
      </PanelSection>
      <PanelSection title="重複として除外する">
        {item.duplicateCandidates.length === 0 ? (
          <p className="text-sm text-gray-400">同じ金額のレシート（前後7日）がありません</p>
        ) : (
          <>
            <p className="text-xs text-gray-500">二重に登録された相手のレシートを選んでください。行は削除せず、集計から外します。</p>
            <ul className="space-y-1.5">
              {item.duplicateCandidates.map((c) => (
                <li key={c.id}>
                  <label
                    className={cn(
                      "flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2",
                      partnerId === c.id ? "border-indigo-500 bg-indigo-50" : "border-gray-200"
                    )}
                  >
                    <input
                      type="radio"
                      name={`dup-${item.id}`}
                      className="h-5 w-5 accent-indigo-600"
                      checked={partnerId === c.id}
                      onChange={() => setPartnerId(c.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{c.storeName}</p>
                      <p className="text-xs text-gray-500">{shortDate(c.date)}</p>
                    </div>
                    <span className="text-sm tabular-nums">{formatCurrency(c.amount)}</span>
                  </label>
                </li>
              ))}
            </ul>
            <input
              className="h-11 w-full rounded-lg border border-gray-300 px-3 text-base md:h-9 md:text-sm"
              placeholder="理由（任意。例: 同じレシートを2回撮影）"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              variant="outline"
              className="w-full"
              disabled={busy || !partnerId}
              onClick={() =>
                run([{ kind: "duplicate", receiptId: item.id, partnerId: partnerId!, note: note || null, expected }])
              }
            >
              重複として除外
            </Button>
          </>
        )}
      </PanelSection>
      <PanelSection title="その他">
        <Button
          variant="ghost"
          className="w-full text-gray-600"
          disabled={busy}
          onClick={() => run([{ kind: "unknown", id: item.id, expected }])}
        >
          Unknown（返金・調整など）にする
        </Button>
      </PanelSection>
    </div>
  );
}

function CardPanel({
  item,
  categories,
  busy,
  run,
  linkOperation,
}: {
  item: CardItem;
  categories: Category[];
  busy: boolean;
  run: Run;
  linkOperation: LinkOp;
}) {
  const expected = { [item.id]: item.version };
  const [categoryId, setCategoryId] = useState<string>(item.categoryId ?? "");
  const [createRule, setCreateRule] = useState(false);
  const [parts, setParts] = useState<{ categoryId: string; amount: string }[]>([
    { categoryId: item.categoryId ?? "", amount: String(item.amount) },
    { categoryId: "", amount: "" },
  ]);
  const partAmounts = parts.map((p) => Number(p.amount));
  const partsTotal = partAmounts.reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0);
  const remaining = item.amount - partsTotal;
  const partsValid =
    parts.length >= 2 &&
    parts.every((p, i) => p.categoryId && Number.isInteger(partAmounts[i]) && partAmounts[i] > 0) &&
    remaining === 0;

  return (
    <div>
      <PanelHeader item={item} />
      {item.amount > 0 ? (
        <LinkSection item={item} busy={busy} run={run} linkOperation={linkOperation} candidateLabel="レシート" />
      ) : null}
      {item.amount > 0 ? (
        <PanelSection title="カードだけで確定する（レシートが無い支出）">
          <p className="text-xs text-gray-500">ETC・電気・ガス・通信費・サブスクなど。確定すると「確定済み」に移ります。</p>
          <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} aria-label="確定するカテゴリ" />
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-indigo-600"
              checked={createRule}
              onChange={(e) => setCreateRule(e.target.checked)}
            />
            この店は今後、レシートなしで自動確定する
          </label>
          {createRule ? (
            <p className="text-xs text-gray-500">
              次回以降のCSV取込で、店名が「{item.storeName}」（正規化後: {item.ruleKey}）の明細を自動で確定します。ルール管理の画面で無効化・削除できます。
            </p>
          ) : null}
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !categoryId}
            onClick={() =>
              run([
                {
                  kind: "card_only",
                  cardId: item.id,
                  parts: [{ categoryId, amount: item.amount }],
                  createRule,
                  expected,
                },
              ])
            }
            data-testid="card-only-submit"
          >
            レシートなしで確定
          </Button>
        </PanelSection>
      ) : null}
      {item.amount > 0 ? (
        <PanelSection title="複数のカテゴリに分ける">
          <ul className="space-y-2">
            {parts.map((p, i) => (
              <li key={i} className="flex items-center gap-2">
                <CategorySelect
                  categories={categories}
                  value={p.categoryId}
                  onChange={(v) => setParts((ps) => ps.map((x, j) => (j === i ? { ...x, categoryId: v } : x)))}
                  className="min-w-0 flex-1"
                  aria-label={`内訳${i + 1}のカテゴリ`}
                />
                <input
                  inputMode="numeric"
                  className="h-11 w-24 flex-shrink-0 rounded border border-gray-300 px-2 text-right text-base tabular-nums md:h-9 md:text-sm"
                  value={p.amount}
                  aria-label={`内訳${i + 1}の金額`}
                  onChange={(e) =>
                    setParts((ps) =>
                      ps.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(/[^\d]/g, "") } : x))
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="flex-shrink-0"
                  aria-label="この内訳を削除"
                  disabled={parts.length <= 2}
                  onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4 text-gray-400" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-10"
              disabled={parts.length >= 10}
              onClick={() => setParts((ps) => [...ps, { categoryId: "", amount: remaining > 0 ? String(remaining) : "" }])}
            >
              <Plus className="h-4 w-4" />
              内訳を追加
            </Button>
            <span
              className={cn("text-sm tabular-nums", remaining === 0 ? "text-emerald-700" : "text-amber-700")}
              data-testid="split-remaining"
            >
              {remaining === 0 ? "合計が一致しています" : `残り ${signedYen(remaining)}`}
            </span>
          </div>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !partsValid}
            onClick={() =>
              run([
                {
                  kind: "card_only",
                  cardId: item.id,
                  parts: parts.map((p, i) => ({ categoryId: p.categoryId, amount: partAmounts[i] })),
                  expected,
                },
              ])
            }
            data-testid="split-submit"
          >
            分けて確定
          </Button>
        </PanelSection>
      ) : null}
      <PanelSection title="その他">
        <Button
          variant="ghost"
          className="w-full text-gray-600"
          disabled={busy}
          onClick={() => run([{ kind: "unknown", id: item.id, expected }])}
        >
          Unknown（返金・調整など）にする
        </Button>
      </PanelSection>
    </div>
  );
}

function PanelHeader({ item }: { item: Item }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2">
      <div className="min-w-0 text-sm text-gray-600">
        <span className="mr-2">{item.kind === "receipt" ? (item.autoCash ? "自動現金のレシート" : "レシート") : "カード明細"}</span>
        <span>{item.date.replaceAll("-", "/")}</span>
        {item.kind === "receipt" && item.rowCount > 1 ? <span className="ml-2">品目{item.rowCount}行</span> : null}
      </div>
      <span className="flex-shrink-0 text-lg font-semibold tabular-nums">{formatCurrency(item.amount)}</span>
    </div>
  );
}

function UndoButton({ opId, busy, undo }: { opId: string | null; busy: boolean; undo: (opId: string) => void }) {
  if (!opId) return null;
  return (
    <Button variant="ghost" className="h-10 flex-shrink-0 px-2 text-xs md:h-8" disabled={busy} onClick={() => undo(opId)}>
      <Undo2 className="h-4 w-4" />
      取り消す
    </Button>
  );
}

function SettledLists({
  data,
  categoryName,
  busy,
  run,
  undo,
}: {
  data: ReconcileView;
  categoryName: Map<string, string>;
  busy: boolean;
  run: Run;
  undo: (opId: string) => void;
}) {
  const group = (title: string, count: number, children: ReactNode) => (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold text-gray-800">
        {title}
        <span className="ml-2 text-xs font-normal text-gray-500">{count}件</span>
      </h3>
      {count === 0 ? <p className="py-1 text-sm text-gray-400">ありません</p> : children}
    </section>
  );
  return (
    <div className="space-y-5">
      {group(
        "確定済み（レシート無し）",
        data.cardOnlySettled.length,
        <ul className="divide-y divide-gray-100">
          {data.cardOnlySettled.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{c.storeName}</p>
                <p className="flex flex-wrap gap-x-2 text-xs text-gray-500">
                  <span>{shortDate(c.date)}</span>
                  {c.parts.map((p) => (
                    <span key={p.id}>
                      {p.categoryId ? categoryName.get(p.categoryId) ?? "?" : "未分類"} {formatCurrency(p.amount)}
                    </span>
                  ))}
                  {c.hasReceiptCandidate ? (
                    <span className="rounded bg-amber-100 px-1 text-amber-800">紐付け候補あり</span>
                  ) : null}
                </p>
              </div>
              <span className="flex-shrink-0 text-sm tabular-nums">{formatCurrency(c.amount)}</span>
              <UndoButton opId={c.undoOpId} busy={busy} undo={undo} />
            </li>
          ))}
        </ul>
      )}
      {group(
        "照合済み",
        data.matchedPairs.length,
        <ul className="divide-y divide-gray-100">
          {data.matchedPairs.map((p) => (
            <li key={p.cardId} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate">
                  カード {shortDate(p.cardDate)} {p.cardStoreName}
                  {p.linkedCardCount > 1 ? <span className="ml-1 text-xs text-gray-400">（{p.linkedCardCount}件で1枚）</span> : null}
                </p>
                <p className="truncate text-gray-600">
                  レシート {p.receiptDate ? shortDate(p.receiptDate) : "-"} {p.receiptStoreName ?? ""}
                  {p.linkedReceiptCount > 1 ? <span className="ml-1 text-xs text-gray-400">ほか{p.linkedReceiptCount - 1}枚</span> : null}
                </p>
                <p className="text-xs text-gray-400">{p.manual ? "手動で紐付け" : "自動で照合"}</p>
              </div>
              <span className="flex-shrink-0 text-sm tabular-nums">{formatCurrency(p.amount)}</span>
              {p.undoOpId ? (
                <UndoButton opId={p.undoOpId} busy={busy} undo={undo} />
              ) : (
                <Button
                  variant="ghost"
                  className="h-10 flex-shrink-0 px-2 text-xs md:h-8"
                  disabled={busy}
                  onClick={() => run([{ kind: "unlink", cardId: p.cardId, expected: { [p.cardId]: p.version } }])}
                >
                  解除
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {group(
        "現金で確定",
        data.cashConfirmed.length,
        <ul className="divide-y divide-gray-100">
          {data.cashConfirmed.map((c) => (
            <li key={c.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{c.storeName}</p>
                <p className="text-xs text-gray-500">
                  {shortDate(c.date)}
                  {c.undoOpId ? "" : "（入力時に現金）"}
                </p>
              </div>
              <span className="flex-shrink-0 text-sm tabular-nums">{formatCurrency(c.amount)}</span>
              <UndoButton opId={c.undoOpId} busy={busy} undo={undo} />
            </li>
          ))}
        </ul>
      )}
      {group(
        "重複として除外",
        data.duplicatesExcluded.length,
        <ul className="divide-y divide-gray-100">
          {data.duplicatesExcluded.map((d) => (
            <li key={d.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{d.storeName}</p>
                <p className="text-xs text-gray-500">{shortDate(d.date)}</p>
              </div>
              <span className="flex-shrink-0 text-sm tabular-nums">{formatCurrency(d.amount)}</span>
              <UndoButton opId={d.undoOpId} busy={busy} undo={undo} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryList({ data, busy, undo }: { data: ReconcileView; busy: boolean; undo: (opId: string) => void }) {
  if (data.operations.length === 0) {
    return <p className="py-6 text-center text-sm text-gray-400">操作の履歴はありません</p>;
  }
  return (
    <ul className="divide-y divide-gray-100" data-testid="history">
      {data.operations.map((op) => (
        <li key={op.id} className="flex items-center gap-2 py-2">
          <div className="min-w-0 flex-1">
            <p className={cn("break-words text-sm", op.undoneAt && "text-gray-400 line-through")}>{op.summary}</p>
            <p className="text-xs text-gray-500">
              {new Date(op.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
              {op.actor === "rule" ? "（ルールで自動）" : ""}
              {op.undoneAt ? "（取り消し済み）" : ""}
            </p>
          </div>
          {op.kind !== "undo" && !op.undoneAt ? <UndoButton opId={op.id} busy={busy} undo={undo} /> : null}
        </li>
      ))}
    </ul>
  );
}

type BulkAction = "topExact" | "cash" | "category";
type BulkPlan = {
  action: BulkAction;
  targets: { item: Item; candidateId?: string }[];
  skipped: { item: Item; reason: string }[];
};

const BULK_LABEL: Record<BulkAction, string> = {
  topExact: "候補1番を一括採用（金額が完全一致する候補のみ）",
  cash: "まとめて現金確定",
  category: "まとめてカテゴリ確定（レシートなし）",
};

function BulkConfirm({
  plan,
  categories,
  onCancel,
  onExecute,
}: {
  plan: BulkPlan | null;
  categories: Category[];
  onCancel: () => void;
  onExecute: (plan: BulkPlan, categoryId: string | null) => void;
}) {
  const [categoryId, setCategoryId] = useState("");
  const total = plan?.targets.reduce((s, t) => s + t.item.amount, 0) ?? 0;
  return (
    <Sheet open={!!plan} onClose={onCancel} title="一括操作の確認">
      {plan ? (
        <div className="space-y-3" data-testid="bulk-confirm">
          <p className="text-sm font-medium">{BULK_LABEL[plan.action]}</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-indigo-50 px-3 py-2">
              <p className="text-xs text-indigo-700">実行する件数</p>
              <p className="text-lg font-semibold tabular-nums">{plan.targets.length}件</p>
            </div>
            <div className="rounded-lg bg-indigo-50 px-3 py-2">
              <p className="text-xs text-indigo-700">合計金額</p>
              <p className="text-lg font-semibold tabular-nums">{formatCurrency(total)}</p>
            </div>
          </div>
          {plan.targets.length > 0 ? (
            <ul className="max-h-48 divide-y divide-gray-100 overflow-y-auto rounded border border-gray-100 text-sm">
              {plan.targets.map(({ item }) => (
                <li key={keyOf(item)} className="flex justify-between gap-2 px-2 py-1.5">
                  <span className="min-w-0 truncate">
                    {shortDate(item.date)} {item.storeName}
                  </span>
                  <span className="flex-shrink-0 tabular-nums">{formatCurrency(item.amount)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {plan.skipped.length > 0 ? (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <p className="font-medium">対象外 {plan.skipped.length}件（手動で操作してください）</p>
              <ul className="mt-1 space-y-0.5">
                {plan.skipped.slice(0, 8).map(({ item, reason }) => (
                  <li key={keyOf(item)} className="truncate">
                    {item.storeName} {formatCurrency(item.amount)}：{reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {plan.action === "category" ? (
            <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} aria-label="確定するカテゴリ" />
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={onCancel}>
              やめる
            </Button>
            <Button
              disabled={plan.targets.length === 0 || (plan.action === "category" && !categoryId)}
              onClick={() => onExecute(plan, plan.action === "category" ? categoryId : null)}
              data-testid="bulk-execute"
            >
              {plan.targets.length}件を実行
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
