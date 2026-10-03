"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn, formatCurrency, getMonthKey, shiftMonthKey } from "@/lib/utils";
import type { ReconcileView } from "@/lib/reconcile-service";

type Row = {
  id: string;
  date: string;
  storeName: string;
  amount: number;
  rowCount?: number;
  reason?: "no_csv_coverage" | "no_candidate" | null;
};

const REASON_LABEL = {
  no_csv_coverage: "CSV未取込の期間",
  no_candidate: "該当するカード明細なし",
} as const;

function shortDate(date: string) {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function fullDate(date: string) {
  const [y, m, d] = date.split("-");
  return `${y}/${Number(m)}/${Number(d)}`;
}

function Section({
  title,
  description,
  count,
  children,
}: {
  title: string;
  description?: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {title}
          <span className="ml-2 text-sm font-normal text-gray-500">{count}件</span>
        </CardTitle>
        {description ? <p className="text-xs text-gray-500">{description}</p> : null}
      </CardHeader>
      <CardContent>
        {count === 0 ? <p className="py-2 text-sm text-gray-400">ありません</p> : children}
      </CardContent>
    </Card>
  );
}

function RowLine({ row, action }: { row: Row; action?: ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-gray-900">
          {row.storeName}
          {row.rowCount && row.rowCount > 1 ? (
            <span className="ml-1 text-xs text-gray-400">（品目{row.rowCount}行）</span>
          ) : null}
        </p>
        <p className="text-xs text-gray-500">
          {shortDate(row.date)}
          {row.reason ? (
            <span
              className={cn(
                "ml-2 rounded px-1",
                row.reason === "no_csv_coverage"
                  ? "bg-gray-100 text-gray-600"
                  : "bg-amber-100 text-amber-800"
              )}
            >
              {REASON_LABEL[row.reason]}
            </span>
          ) : null}
        </p>
      </div>
      <span className="flex-shrink-0 text-sm font-medium tabular-nums">
        {formatCurrency(row.amount)}
      </span>
      {action}
    </li>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-gray-50 px-3 py-2">
      <p className="truncate text-xs text-gray-500">{label}</p>
      <p className="truncate text-base font-semibold tabular-nums text-gray-900">{value}</p>
      {sub ? <p className="truncate text-xs text-gray-500">{sub}</p> : null}
    </div>
  );
}

export default function ReconcilePage() {
  const [month, setMonth] = useState(getMonthKey(new Date()));
  const [data, setData] = useState<ReconcileView | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requestKey = `${month}:${reloadCount}`;
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reconcile?month=${month}`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((json: ReconcileView | null) => {
        if (cancelled) return;
        if (json) setData(json);
        setLoadedKey(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [month, requestKey]);

  const act = async (body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(typeof json.error === "string" ? json.error : "操作に失敗しました");
        return;
      }
      if (typeof json.matched === "number") {
        setMessage(`再照合しました（新たに照合${json.matched}件）`);
      }
      setReloadCount((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const [y, m] = month.split("-");
  const s = data?.summary;
  const smallBtn = "h-9 flex-shrink-0 px-2 text-xs md:h-7";

  return (
    <div className="min-w-0 space-y-5 overflow-x-hidden">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900">カード明細とレシートの照合</h1>
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMonth((v) => shiftMonthKey(v, -1))}
            aria-label="前月"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[100px] text-center text-sm font-medium">
            {y}年{Number(m)}月
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setMonth((v) => shiftMonthKey(v, 1))}
            disabled={month >= getMonthKey(new Date())}
            aria-label="次月"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => act({ action: "rerun" })}>
            <RefreshCw className="h-4 w-4" />
            再照合
          </Button>
        </div>
      </div>

      {message ? (
        <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-700">{message}</p>
      ) : null}

      {loading || !data || !s ? (
        <p className="py-10 text-center text-gray-400">読み込み中...</p>
      ) : (
        <>
          <Card className="min-w-0">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">月のサマリー</CardTitle>
              <p className="break-words text-xs text-gray-500">
                {data.monthCoverage.ranges.length > 0
                  ? `この月のカード明細（利用日）: ${data.monthCoverage.ranges
                      .map((r) => `${shortDate(r.from)}〜${shortDate(r.to)}`)
                      .join("、")}（${data.monthCoverage.cardCount}件）`
                  : "この月の利用日を含むカード明細CSVはまだ取り込まれていません"}
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label="総支出" value={formatCurrency(s.total)} />
                <Stat label="カード決済分" value={formatCurrency(s.card)} />
                <Stat label="現金決済分" value={formatCurrency(s.cash)} />
                <Stat
                  label="暫定（未確定のレシート等）"
                  value={formatCurrency(s.provisional)}
                  sub={s.adjustment !== 0 ? `Unknown ${formatCurrency(s.adjustment)}` : undefined}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat
                  label="カード明細"
                  value={formatCurrency(s.cardStatement.amount)}
                  sub={`${s.cardStatement.count}件`}
                />
                <Stat
                  label="照合済み"
                  value={formatCurrency(s.matched.amount)}
                  sub={`${s.matched.count}件`}
                />
                <Stat
                  label="レシート未照合（撮り忘れ候補）"
                  value={formatCurrency(s.unmatchedCards.amount)}
                  sub={`${s.unmatchedCards.count}件`}
                />
                <Stat
                  label="未照合のレシート"
                  value={`${s.unmatchedReceipts.count}件`}
                  sub={formatCurrency(s.unmatchedReceipts.amount)}
                />
                <Stat
                  label="うちCSV未取込の期間"
                  value={`${s.unmatchedNoCoverage.count}件`}
                  sub={formatCurrency(s.unmatchedNoCoverage.amount)}
                />
                <Stat
                  label="うち該当カード明細なし"
                  value={`${s.unmatchedNoCandidate.count}件`}
                  sub={formatCurrency(s.unmatchedNoCandidate.amount)}
                />
                <Stat
                  label="現金（確定）"
                  value={formatCurrency(s.cashConfirmed.amount)}
                  sub={`${s.cashConfirmed.count}件`}
                />
                <Stat
                  label="現金（自動判定）"
                  value={formatCurrency(s.cashAuto.amount)}
                  sub={`${s.cashAuto.count}件`}
                />
              </div>
              {data.legacyLineItemCount > 0 ? (
                <p className="text-xs text-gray-500">
                  レシートIDが無い旧形式の品目行 {data.legacyLineItemCount}
                  行は照合の対象外です（集計には含まれます）。
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Section
            title="CSVの取込状況"
            description="月は利用日で判定します（ファイル名や支払月は使いません）。現金への自動判定は、各CSVの利用日の範囲内だけで行います。"
            count={data.importBatches.length}
          >
            <ul className="divide-y divide-gray-100">
              {data.importBatches.map((b) => (
                <li key={b.id} className="space-y-0.5 py-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="min-w-0 break-all font-medium text-gray-900">
                      {b.fileName ?? (b.legacy ? "以前の取込（ファイル名の記録なし）" : "ファイル名なし")}
                    </span>
                    <span className="flex-shrink-0 text-xs text-gray-500">{b.count}件</span>
                  </div>
                  <p className="break-words text-xs text-gray-600">
                    利用日 {fullDate(b.from)}〜{fullDate(b.to)}
                    {b.paymentMonth ? ` ／ 支払月 ${b.paymentMonth.replace("-", "/")}` : ""}
                    {b.importedAt ? ` ／ 取込 ${fullDate(b.importedAt.slice(0, 10))}` : ""}
                  </p>
                  {b.segments.length > 1 ||
                  (b.segments.length === 1 &&
                    (b.segments[0].from !== b.from || b.segments[0].to !== b.to)) ? (
                    <p className="break-words text-xs text-gray-500">
                      現金判定に使う範囲:{" "}
                      {b.segments.map((g) => `${shortDate(g.from)}〜${shortDate(g.to)}`).join("、")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>

          <div className="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
            {data.outOfRangeMatches.length > 0 ? (
              <Section
                title="日付差が31日を超える照合"
                description="以前の照合で、日付が離れすぎている組です。誤りなら解除してください（自動では解除しません）。"
                count={data.outOfRangeMatches.length}
              >
                <ul className="divide-y divide-gray-100">
                  {data.outOfRangeMatches.map((m) => (
                    <li key={m.cardId} className="flex items-center gap-3 py-2">
                      <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                        <p className="truncate">
                          カード {shortDate(m.cardDate)} {m.cardStoreName ?? ""}
                        </p>
                        <p className="truncate text-gray-600">
                          レシート {shortDate(m.receiptDate)}
                        </p>
                        <p className="text-xs text-amber-700">日付差 {m.dateDiffDays}日</p>
                      </div>
                      {m.amount !== null ? (
                        <span className="flex-shrink-0 text-sm font-medium tabular-nums">
                          {formatCurrency(m.amount)}
                        </span>
                      ) : null}
                      <Button
                        variant="ghost"
                        className={smallBtn}
                        disabled={busy}
                        onClick={() =>
                          act(
                            { action: "unlink", cardId: m.cardId },
                            "この照合を解除して未照合に戻しますか？"
                          )
                        }
                      >
                        解除
                      </Button>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            <Section
              title="店名の判定不可"
              description="AI が同じ店か判断できなかった組です。教えた答えは次回以降の判断材料になります。"
              count={data.undeterminedPairs.length}
            >
              <ul className="divide-y divide-gray-100">
                {data.undeterminedPairs.map((p) => (
                  <li key={`${p.cardSample}-${p.receiptSample}`} className="space-y-2 py-2">
                    <p className="break-words text-sm text-gray-900">
                      カード「{p.cardSample}」／ レシート「{p.receiptSample}」
                    </p>
                    {p.merchant || p.reason ? (
                      <p className="break-words text-xs text-gray-500">
                        {p.merchant ? `AIの調査: ${p.merchant}。` : ""}
                        {p.reason ?? ""}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          act({
                            action: "teach",
                            cardName: p.cardSample,
                            receiptName: p.receiptSample,
                            verdict: "same",
                          })
                        }
                      >
                        同じ店
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          act({
                            action: "teach",
                            cardName: p.cardSample,
                            receiptName: p.receiptSample,
                            verdict: "different",
                          })
                        }
                      >
                        別の店
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>

            <Section
              title="要確認の照合"
              description="日付差が14日を超える、またはレシート日付がカードより後の照合です。"
              count={data.matchedPairs.filter((p) => p.needsReview).length}
            >
              <PairList
                pairs={data.matchedPairs.filter((p) => p.needsReview)}
                busy={busy}
                onUnlink={(cardId) =>
                  act({ action: "unlink", cardId }, "この照合を解除して未照合に戻しますか？")
                }
              />
            </Section>

            <Section
              title="レシート未照合のカード明細"
              description="店名からカテゴリを推測した1件として計上しています。"
              count={data.unmatchedCards.length}
            >
              <ul className="divide-y divide-gray-100">
                {data.unmatchedCards.map((r) => (
                  <RowLine
                    key={r.id}
                    row={r}
                    action={
                      <Button
                        variant="ghost"
                        className={smallBtn}
                        disabled={busy}
                        onClick={() => act({ action: "mark_unknown", ids: [r.id] })}
                      >
                        Unknownへ
                      </Button>
                    }
                  />
                ))}
              </ul>
            </Section>

            <Section
              title="未照合のレシート"
              description="「CSV未取込の期間」は該当期間のCSVを取り込むと照合されます。現金への自動判定はCSV取込時に、そのCSVの範囲内だけで行います。"
              count={data.unmatchedReceipts.length}
            >
              <ul className="divide-y divide-gray-100">
                {data.unmatchedReceipts.map((r) => (
                  <RowLine
                    key={r.id}
                    row={r}
                    action={
                      <Button
                        variant="ghost"
                        className={smallBtn}
                        disabled={busy}
                        onClick={() => act({ action: "mark_unknown", ids: [r.id] })}
                      >
                        Unknownへ
                      </Button>
                    }
                  />
                ))}
              </ul>
            </Section>

            <Section
              title="自動で現金に判定されたレシート"
              description="カード決済だったものが紛れていないか確認してください。"
              count={data.autoCashReceipts.length}
            >
              <ul className="divide-y divide-gray-100">
                {data.autoCashReceipts.map((r) => (
                  <RowLine
                    key={r.id}
                    row={r}
                    action={
                      <Button
                        variant="outline"
                        className={smallBtn}
                        disabled={busy}
                        onClick={() => act({ action: "revert_cash", ids: [r.id] })}
                      >
                        カード扱いに戻す
                      </Button>
                    }
                  />
                ))}
              </ul>
            </Section>

            <Section
              title="金額不一致の候補（参考）"
              description="同じ店で金額が一致しない組です（日付差31日以内）。自動では紐付けません。「税抜で読み取った可能性」の付いたレシートは、現金への自動判定から除外しています。"
              count={data.mismatchCandidates.length}
            >
              <ul className="divide-y divide-gray-100">
                {data.mismatchCandidates.map((c) => (
                  <li key={`${c.cardId}-${c.receipt.id}`} className="space-y-0.5 py-2 text-sm">
                    <div className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">
                        カード {shortDate(c.cardDate)} {c.cardStoreName}
                      </span>
                      <span className="flex-shrink-0 tabular-nums">
                        {formatCurrency(c.cardAmount)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-3 text-gray-600">
                      <span className="min-w-0 truncate">
                        レシート {shortDate(c.receipt.date)} {c.receipt.storeName}
                        {c.receiptIsAutoCash ? (
                          <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-700">
                            自動現金
                          </span>
                        ) : null}
                        {c.taxExclusiveLikely ? (
                          <span className="ml-1 rounded bg-sky-100 px-1 text-xs text-sky-800">
                            税抜で読み取った可能性
                          </span>
                        ) : null}
                      </span>
                      <span className="flex-shrink-0 tabular-nums">
                        {formatCurrency(c.receipt.amount)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>

            <Section
              title="Unknown（返金・調整など）"
              description="照合の対象外です。削除すると一覧・集計から消えます（データは内部に残ります）。"
              count={data.unknownRows.length}
            >
              <ul className="divide-y divide-gray-100">
                {data.unknownRows.map((r) => (
                  <RowLine
                    key={r.id}
                    row={r}
                    action={
                      <Button
                        variant="destructive"
                        className={smallBtn}
                        disabled={busy}
                        onClick={() =>
                          act(
                            { action: "delete_unknown", ids: [r.id] },
                            `「${r.storeName}」を一覧・集計から削除しますか？`
                          )
                        }
                      >
                        削除
                      </Button>
                    }
                  />
                ))}
              </ul>
            </Section>

            <Section title="照合済み" count={data.matchedPairs.length}>
              <PairList
                pairs={data.matchedPairs}
                busy={busy}
                onUnlink={(cardId) =>
                  act({ action: "unlink", cardId }, "この照合を解除して未照合に戻しますか？")
                }
              />
            </Section>
          </div>
        </>
      )}
    </div>
  );
}

function PairList({
  pairs,
  busy,
  onUnlink,
}: {
  pairs: ReconcileView["matchedPairs"];
  busy: boolean;
  onUnlink: (cardId: string) => void;
}) {
  return (
    <ul className="divide-y divide-gray-100">
      {pairs.map((p) => (
        <li key={p.cardId} className="flex items-center gap-3 py-2">
          <div className="min-w-0 flex-1 space-y-0.5 text-sm">
            <p className="truncate">
              カード {shortDate(p.cardDate)} {p.cardStoreName}
            </p>
            <p className="truncate text-gray-600">
              レシート {p.receiptDate ? shortDate(p.receiptDate) : "-"} {p.receiptStoreName ?? ""}
            </p>
            {p.dateDiffDays !== null ? (
              <p className={cn("text-xs", p.needsReview ? "text-amber-700" : "text-gray-400")}>
                日付差 {p.dateDiffDays > 0 ? `+${p.dateDiffDays}` : p.dateDiffDays}日
              </p>
            ) : null}
          </div>
          <span className="flex-shrink-0 text-sm font-medium tabular-nums">
            {formatCurrency(p.amount)}
          </span>
          <Button
            variant="ghost"
            className="h-9 flex-shrink-0 px-2 text-xs md:h-7"
            disabled={busy}
            onClick={() => onUnlink(p.cardId)}
          >
            解除
          </Button>
        </li>
      ))}
    </ul>
  );
}
