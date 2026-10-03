/**
 * 既存データの補正スクリプト。元の値は Transaction.corrections に残し、--revert で戻せる。
 * 行は削除しない（集計から外す場合は excludedReason を付ける）。例外は --revert tax_line で、
 * このスクリプトが追加した「消費税」の行だけを削除する。
 *
 *   legacy_group : レシートIDの無い旧形式の品目行を、同じ保存時刻・日付・店名でレシート1枚にまとめる
 *   exclude      : 同じレシートの二重登録（品目と金額が完全に一致し、別々の取込で保存されたもの）と、
 *                  カード明細の画像の同じ注文番号の二重読み取りを、集計から外す
 *   date_fix     : 年の読み違い（2年以上前・未来の日付）を、同じ取込で保存した他の行の年に直す
 *   tax_line     : 税抜で保存したレシートに、カード明細の金額を正として「消費税」の行を加える
 *                  （同じ店・日付差3日以内・差額が品目合計の0〜10%（端数±2円）・1対1に限る）
 *
 * ドライラン（書き込みなし）: npx tsx --env-file=.env.local scripts/data-corrections.ts
 * 本実行（Transaction を全件バックアップしてから実行）:  ... --apply
 * 元に戻す:  ... --revert legacy_group|exclude|date_fix|tax_line|all
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma, Transaction } from "../src/generated/prisma";
import { prisma } from "../src/lib/prisma";
import { parseReceiptItemsMemo } from "../src/lib/receipt-aggregation";
import {
  buildReceiptUnits,
  DEFAULT_MAX_DAYS,
  diffDays,
  isLegacyLineItem,
  storeNameOf,
  type LedgerRow,
  type ReceiptUnit,
} from "../src/lib/reconcile";
import {
  loadJudgements,
  makeStoreJudge,
  releaseLinks,
  runReconciliation,
  toLedgerRow,
} from "../src/lib/reconcile-service";
import { compareStoreNames, normalizeStoreName, ruleBasedStoreVerdict } from "../src/lib/store-name";

/** 消費税行を加える組の、カード利用日とレシート日付の差の上限（日） */
const TAX_MAX_DATE_DIFF = 3;

type Kind = "legacy_group" | "exclude" | "date_fix" | "tax_line";
const KINDS: Kind[] = ["legacy_group", "exclude", "date_fix", "tax_line"];

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const revertArg = argv.includes("--revert") ? argv[argv.indexOf("--revert") + 1] : null;

const BACKUP_DIR = path.join(process.cwd(), "backups");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

type Correction = { kind: string; at: string; [key: string]: unknown };

function correctionsOf(tx: Pick<Transaction, "corrections">): Correction[] {
  return Array.isArray(tx.corrections) ? (tx.corrections as Correction[]) : [];
}

function withCorrection(tx: Pick<Transaction, "corrections">, entry: Omit<Correction, "at">) {
  return [...correctionsOf(tx), { ...entry, at: new Date().toISOString() }] as Prisma.InputJsonValue;
}

const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

type Item = { name: string; amount: number };

function unitItems(unit: ReceiptUnit, rowById: Map<string, Transaction>): Item[] {
  const rows = unit.rowIds.map((id) => rowById.get(id)!);
  if (rows.length === 1) {
    const memo = parseReceiptItemsMemo(rows[0].memo);
    if (memo) return memo.items.map((i) => ({ name: i.itemName, amount: i.amount }));
  }
  return rows.map((r) => {
    const idx = r.description.indexOf(" / ");
    return { name: idx > 0 ? r.description.slice(idx + 3) : r.description, amount: r.amount };
  });
}

function importedAt(unit: ReceiptUnit, rowById: Map<string, Transaction>): number {
  return Math.min(...unit.rowIds.map((id) => rowById.get(id)!.createdAt.getTime()));
}

function sameStore(a: string, b: string) {
  return normalizeStoreName(a) === normalizeStoreName(b) || ruleBasedStoreVerdict(a, b) === "same";
}

async function main() {
  if (revertArg) return revert(revertArg);

  const all = await prisma.transaction.findMany({ orderBy: [{ date: "asc" }, { id: "asc" }] });
  const active = all.filter((t) => !t.archived && !t.deletedAt && !t.excludedReason && t.confirmed);
  const rowById = new Map(all.map((t) => [t.id, t]));
  const judgements = await loadJudgements();
  const judge = makeStoreJudge(judgements);

  // 1. 旧形式の品目行のレシート単位化
  const legacyRows = active.filter((t) => isLegacyLineItem(toLedgerRow(t)));
  const nonLegacyKeys = new Set(
    active
      .filter((t) => t.source !== "CSV" && !isLegacyLineItem(toLedgerRow(t)))
      .map((t) => `${t.createdAt.getTime()}|${ymd(t.date)}|${normalizeStoreName(storeNameOf(t.description))}`)
  );
  const legacyGroups = new Map<string, Transaction[]>();
  for (const t of legacyRows) {
    const key = `${t.createdAt.getTime()}|${ymd(t.date)}|${normalizeStoreName(storeNameOf(t.description))}`;
    legacyGroups.set(key, [...(legacyGroups.get(key) ?? []), t]);
  }
  const legacyPlan: { groupId: string; rowIds: string[]; date: string; store: string; amount: number }[] = [];
  const legacySkipped: { date: string; store: string; rows: number; reason: string }[] = [];
  for (const [key, rows] of legacyGroups) {
    const store = storeNameOf(rows[0].description);
    if (nonLegacyKeys.has(key)) {
      legacySkipped.push({
        date: ymd(rows[0].date),
        store,
        rows: rows.length,
        reason: "同じ取込・日付・店名に別形式の行があり、1枚のレシートか判断できない",
      });
      continue;
    }
    legacyPlan.push({
      groupId: `legacy-${rows[0].createdAt.getTime()}-${shortHash(key)}`,
      rowIds: rows.map((r) => r.id),
      date: ymd(rows[0].date),
      store,
      amount: rows.reduce((s, r) => s + r.amount, 0),
    });
  }
  const plannedGroupOf = new Map(legacyPlan.flatMap((g) => g.rowIds.map((id) => [id, g.groupId])));

  // 以降の判定は、旧形式の品目行をまとめた後の状態で行う
  let ledger: LedgerRow[] = active.map((t) => ({
    ...toLedgerRow(t),
    receiptGroupId: t.receiptGroupId ?? plannedGroupOf.get(t.id) ?? null,
  }));

  // 2a. レシートの二重登録
  const { units } = buildReceiptUnits(ledger);
  const receiptUnits = units.filter((u) => u.amount > 0);
  const duplicates: {
    keep: { rowIds: string[]; store: string; importedAt: string };
    drop: { rowIds: string[]; store: string; importedAt: string };
    date: string;
    amount: number;
    items: Item[];
    nameMatches: string;
  }[] = [];
  const possibleDuplicates: { date: string; amount: number; stores: string[]; reason: string }[] = [];
  const dropped = new Set<string>();
  const byDateAmount = new Map<string, ReceiptUnit[]>();
  for (const u of receiptUnits) {
    const key = `${u.date}|${u.amount}`;
    byDateAmount.set(key, [...(byDateAmount.get(key) ?? []), u]);
  }
  for (const list of byDateAmount.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => importedAt(a, rowById) - importedAt(b, rowById));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (dropped.has(a.id) || dropped.has(b.id) || !sameStore(a.storeName, b.storeName)) continue;
        const ia = unitItems(a, rowById);
        const ib = unitItems(b, rowById);
        const amountsA = ia.map((x) => x.amount).sort((x, y) => x - y);
        const amountsB = ib.map((x) => x.amount).sort((x, y) => x - y);
        const sameAmounts = amountsA.length === amountsB.length && amountsA.every((v, k) => v === amountsB[k]);
        const separateImports = Math.abs(importedAt(a, rowById) - importedAt(b, rowById)) > 60_000;
        const byAmount = (items: Item[]) => [...items].sort((x, y) => x.amount - y.amount);
        const sa = byAmount(ia);
        const sb = byAmount(ib);
        const nameHits = sa.filter((x, k) => sb[k] && compareStoreNames(x.name, sb[k].name).similar).length;
        const certain =
          sameAmounts && separateImports && ia.length >= 2 && nameHits * 2 >= ia.length;
        if (certain) {
          dropped.add(b.id);
          duplicates.push({
            keep: { rowIds: a.rowIds, store: a.storeName, importedAt: new Date(importedAt(a, rowById)).toISOString() },
            drop: { rowIds: b.rowIds, store: b.storeName, importedAt: new Date(importedAt(b, rowById)).toISOString() },
            date: a.date,
            amount: a.amount,
            items: ia,
            nameMatches: `${nameHits}/${ia.length}`,
          });
        } else {
          possibleDuplicates.push({
            date: a.date,
            amount: a.amount,
            stores: [a.storeName, b.storeName],
            reason: !separateImports
              ? "同じ取込の中の2枚（別々の買い物の可能性）"
              : ia.length < 2
                ? "品目が1つだけで、同じレシートかを品目で確かめられない"
                : !sameAmounts
                  ? "品目の金額の並びが一致しない"
                  : "品目名の一致が半分未満",
          });
        }
      }
    }
  }
  const unitById = new Map(units.map((u) => [u.id, u]));
  const duplicateRowIds = new Set([...dropped].flatMap((id) => unitById.get(id)!.rowIds));

  // 2b. カード明細の画像の同じ注文番号の二重読み取り（同じ取込・同じ店名・同じ金額）
  const ORDER_NO_RE = /[A-Z]{1,3}\d{6,}/i;
  const statementDupes: { keepId: string; dropId: string; description: string; amount: number; keepDate: string; dropDate: string }[] = [];
  const statementRows = active.filter((t) => t.source === "IMAGE" && t.autoCashExempt && ORDER_NO_RE.test(t.description));
  const seenOrder = new Map<string, Transaction>();
  for (const t of [...statementRows].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    const key = `${t.createdAt.getTime()}|${t.description.replace(/\s+/g, "")}|${t.amount}`;
    const first = seenOrder.get(key);
    if (!first) {
      seenOrder.set(key, t);
      continue;
    }
    statementDupes.push({
      keepId: first.id,
      dropId: t.id,
      description: t.description,
      amount: t.amount,
      keepDate: ymd(first.date),
      dropDate: ymd(t.date),
    });
  }
  // 画像とカード明細CSVの両方にある行（参考。片方だけ外すと対になる行との釣り合いが崩れるため自動では外さない）
  const csvRows = active.filter((t) => t.source === "CSV");
  const statementVsCsv = active
    .filter((t) => t.source === "IMAGE" && t.autoCashExempt)
    .flatMap((t) =>
      csvRows
        .filter((c) => c.amount === t.amount && Math.abs(diffDays(ymd(c.date), ymd(t.date))) <= 3)
        .filter((c) => sameStore(c.description, storeNameOf(t.description)))
        .map((c) => ({ imageRow: `${ymd(t.date)} ${t.description} ${t.amount}`, csvRow: `${ymd(c.date)} ${c.description} ${c.amount}` }))
    );

  // 3. 年の読み違い
  const dateFixes: { id: string; description: string; amount: number; from: string; to: string; evidence: string }[] = [];
  const dateUnfixed: { id: string; description: string; date: string; reason: string }[] = [];
  const pastLimit = `${Number(today.slice(0, 4)) - 2}${today.slice(4)}`;
  for (const t of active.filter((x) => x.source !== "CSV")) {
    const d = ymd(t.date);
    if (d >= pastLimit && d <= today) continue;
    const siblings = active.filter(
      (s) => s.id !== t.id && s.createdAt.getTime() === t.createdAt.getTime() && ymd(s.date) >= pastLimit && ymd(s.date) <= today
    );
    const years = [...new Set(siblings.map((s) => ymd(s.date).slice(0, 4)))];
    const fixed = years.length === 1 ? `${years[0]}${d.slice(4)}` : null;
    if (fixed && fixed <= ymd(t.createdAt)) {
      dateFixes.push({
        id: t.id,
        description: t.description,
        amount: t.amount,
        from: d,
        to: fixed,
        evidence: `同じ取込（${t.createdAt.toISOString()}）で保存した他の${siblings.length}行がすべて${years[0]}年（例: ${siblings
          .slice(0, 3)
          .map((s) => `${ymd(s.date)} ${s.description}`)
          .join("、")}）。直した日付は取込日より前`,
      });
    } else {
      dateUnfixed.push({
        id: t.id,
        description: t.description,
        date: d,
        reason: years.length === 0 ? "同じ取込に年を確かめられる行が無い" : `同じ取込の行の年が一つに決まらない（${years.join("・")}）`,
      });
    }
  }
  const dateFixOf = new Map(dateFixes.map((f) => [f.id, f.to]));
  const excludedIds = new Set([...duplicateRowIds, ...statementDupes.map((s) => s.dropId)]);
  ledger = ledger
    .filter((r) => !excludedIds.has(r.id))
    .map((r) => (dateFixOf.has(r.id) ? { ...r, date: dateFixOf.get(r.id)! } : r));

  // 4. 税抜で保存したレシートへの消費税行の追加（1対1に決まる組だけ）
  const after = buildReceiptUnits(ledger).units;
  const openReceipts = after.filter((u) => u.status === "unmatched" && u.amount > 0);
  const openCards = ledger.filter((r) => r.source === "CSV" && r.reconcileStatus === "unmatched" && r.amount > 0);
  type Edge = { card: LedgerRow; unit: ReceiptUnit; diff: number; dateDiff: number };
  const edges: Edge[] = [];
  const farEdges: Edge[] = [];
  for (const card of openCards) {
    for (const unit of openReceipts) {
      if (unit.autoCashExempt) continue; // カード明細の画像などはレシートではない
      const diff = card.amount - unit.amount;
      if (diff <= 0 || diff > unit.amount * 0.1 + 2) continue;
      const dateDiff = diffDays(card.date, unit.date);
      if (Math.abs(dateDiff) > DEFAULT_MAX_DAYS) continue;
      if (unit.rejectedCardIds?.includes(card.id)) continue;
      if (judge(card.description, unit.storeName) !== "same") continue;
      // 店頭の買い物はカードの利用日とレシートの日付が同じになる。離れている組は別の買い物の可能性が高い
      (Math.abs(dateDiff) <= TAX_MAX_DATE_DIFF ? edges : farEdges).push({ card, unit, diff, dateDiff });
    }
  }
  const edgesByCard = new Map<string, Edge[]>();
  const edgesByUnit = new Map<string, Edge[]>();
  for (const e of edges) {
    edgesByCard.set(e.card.id, [...(edgesByCard.get(e.card.id) ?? []), e]);
    edgesByUnit.set(e.unit.id, [...(edgesByUnit.get(e.unit.id) ?? []), e]);
  }
  const describe = (e: Edge) => ({
    card: `${e.card.date} ${e.card.description} ${e.card.amount}`,
    receipt: `${e.unit.date} ${e.unit.storeName} ${e.unit.amount}`,
    diff: e.diff,
    rate: `${((e.diff / e.unit.amount) * 100).toFixed(1)}%`,
    dateDiffDays: e.dateDiff,
  });
  const taxPlan: (Edge & { source: string })[] = [];
  const taxSkipped: (ReturnType<typeof describe> & { reason: string })[] = [];
  for (const e of edges) {
    const unique = edgesByCard.get(e.card.id)!.length === 1 && edgesByUnit.get(e.unit.id)!.length === 1;
    const source = rowById.get(e.unit.rowIds[0])!.source;
    if (unique && source === "IMAGE") taxPlan.push({ ...e, source });
    else
      taxSkipped.push({
        ...describe(e),
        reason: !unique
          ? `1対1に決まらない（このカード明細の候補${edgesByCard.get(e.card.id)!.length}件・このレシートの候補${edgesByUnit.get(e.unit.id)!.length}件）`
          : "手入力の明細（レシート画像ではない）",
      });
  }
  for (const e of farEdges) {
    taxSkipped.push({ ...describe(e), reason: `カードの利用日とレシートの日付が${TAX_MAX_DATE_DIFF}日を超えて離れている` });
  }
  // 参考: すでに自動で現金にしたレシートのうち、同じ店のカード明細と税の差だけ違うもの（自動では直さない）
  const autoCashTaxLike = after
    .filter((u) => u.status === "cash" && u.cashSource === "auto")
    .flatMap((u) =>
      openCards
        .filter((c) => c.amount > u.amount && c.amount - u.amount <= u.amount * 0.1 + 2)
        .filter((c) => Math.abs(diffDays(c.date, u.date)) <= DEFAULT_MAX_DAYS && judge(c.description, u.storeName) === "same")
        .map((c) => ({ card: `${c.date} ${c.description} ${c.amount}`, receipt: `${u.date} ${u.storeName} ${u.amount}` }))
    );

  const report = {
    target: process.env.DATABASE_URL?.includes("localhost") ? "local" : "remote",
    mode: apply ? "apply" : "dry-run",
    legacyGroups: { planned: legacyPlan.length, rows: legacyPlan.reduce((s, g) => s + g.rowIds.length, 0), skipped: legacySkipped, list: legacyPlan.map((g) => ({ date: g.date, store: g.store, rows: g.rowIds.length, amount: g.amount })) },
    duplicateReceipts: duplicates.map((d) => ({ ...d, items: d.items.map((i) => `${i.name} ${i.amount}`) })),
    possibleDuplicatesUntouched: possibleDuplicates,
    statementImageDuplicates: statementDupes,
    statementImageAlsoInCsvUntouched: statementVsCsv,
    dateFixes,
    dateUnfixed,
    taxLines: taxPlan.map(describe),
    taxSkipped,
    autoCashTaxLikeUntouched: autoCashTaxLike,
  };

  if (!apply) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await mkdir(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `pre-corrections-${stamp()}.json`);
  await writeFile(backupFile, JSON.stringify({ transactions: all }, null, 2));
  console.error(`バックアップ: ${backupFile}（取引${all.length}件）`);

  await prisma.$transaction(
    async (tx) => {
      for (const g of legacyPlan) {
        for (const id of g.rowIds) {
          await tx.transaction.update({
            where: { id },
            data: {
              receiptGroupId: g.groupId,
              corrections: withCorrection(rowById.get(id)!, { kind: "legacy_group", originalReceiptGroupId: null }),
            },
          });
        }
      }
      const excludes = [
        ...duplicates.flatMap((d) =>
          d.drop.rowIds.map((id) => ({ id, reason: "duplicate_receipt", evidence: { keptRowIds: d.keep.rowIds, keptImportedAt: d.keep.importedAt, droppedImportedAt: d.drop.importedAt, items: d.items.length, nameMatches: d.nameMatches } }))
        ),
        ...statementDupes.map((s) => ({ id: s.dropId, reason: "duplicate_statement_image", evidence: { keptRowId: s.keepId, keptDate: s.keepDate } })),
      ];
      await releaseLinks(excludes.map((e) => e.id), { rejectPair: false }, tx);
      for (const e of excludes) {
        const current = await tx.transaction.findUniqueOrThrow({ where: { id: e.id } });
        await tx.transaction.update({
          where: { id: e.id },
          data: {
            excludedReason: e.reason,
            corrections: withCorrection(current, { kind: "exclude", reason: e.reason, evidence: e.evidence }),
          },
        });
      }
      for (const f of dateFixes) {
        const current = await tx.transaction.findUniqueOrThrow({ where: { id: f.id } });
        await tx.transaction.update({
          where: { id: f.id },
          data: {
            date: new Date(`${f.to}T00:00:00.000Z`),
            corrections: withCorrection(current, { kind: "date_fix", originalDate: f.from, evidence: f.evidence }),
          },
        });
      }
      for (const p of taxPlan) {
        const rows = await tx.transaction.findMany({ where: { id: { in: p.unit.rowIds } } });
        let groupId = rows[0].receiptGroupId;
        if (!groupId) {
          groupId = parseReceiptItemsMemo(rows[0].memo)?.receiptGroupId ?? `taxfix-${rows[0].id}`;
          await tx.transaction.update({
            where: { id: rows[0].id },
            data: {
              receiptGroupId: groupId,
              corrections: withCorrection(rows[0], { kind: "tax_line_group", originalReceiptGroupId: null }),
            },
          });
        }
        const main = rows.reduce((a, b) => (b.amount > a.amount ? b : a));
        const description = `${p.unit.storeName} / 消費税`;
        const date = new Date(`${p.unit.date}T00:00:00.000Z`);
        const sameKey = await tx.transaction.findMany({
          where: { date, description, amount: p.diff },
          select: { dupIndex: true },
        });
        await tx.transaction.create({
          data: {
            date,
            description,
            amount: p.diff,
            categoryId: main.categoryId,
            source: main.source,
            confirmed: true,
            paymentMethod: main.paymentMethod,
            reconcileStatus: "unmatched",
            receiptGroupId: groupId,
            dupIndex: sameKey.length === 0 ? 0 : Math.max(...sameKey.map((s) => s.dupIndex)) + 1,
            corrections: [
              {
                kind: "auto_tax_line",
                at: new Date().toISOString(),
                cardId: p.card.id,
                cardAmount: p.card.amount,
                receiptAmount: p.unit.amount,
                receiptRowIds: p.unit.rowIds,
              },
            ],
          },
        });
      }
    },
    { timeout: 120_000 }
  );

  const rerun = await runReconciliation({ useAi: false, finalizeCash: false });
  console.log(JSON.stringify({ ...report, backupFile, reconciliation: rerun }, null, 2));
}

async function revert(kindArg: string) {
  const kinds = kindArg === "all" ? KINDS : [kindArg as Kind];
  if (!kinds.every((k) => KINDS.includes(k))) throw new Error(`--revert には ${KINDS.join("|")}|all を指定してください`);
  const rows = (await prisma.transaction.findMany()).filter((r) => correctionsOf(r).length > 0);
  await mkdir(BACKUP_DIR, { recursive: true });
  const backupFile = path.join(BACKUP_DIR, `pre-revert-${stamp()}.json`);
  await writeFile(backupFile, JSON.stringify({ transactions: rows }, null, 2));

  const has = (r: Transaction, kind: string) => correctionsOf(r).some((c) => c.kind === kind);
  // 同じ行に複数の補正がある場合に備え、毎回いまの値から履歴を外す
  const drop = async (tx: Prisma.TransactionClient, id: string, kind: string) =>
    correctionsOf(await tx.transaction.findUniqueOrThrow({ where: { id } })).filter(
      (c) => c.kind !== kind
    ) as Prisma.InputJsonValue;
  const summary: Record<string, number> = {};

  await prisma.$transaction(
    async (tx) => {
      if (kinds.includes("tax_line")) {
        const added = rows.filter((r) => has(r, "auto_tax_line"));
        await releaseLinks(added.map((r) => r.id), { rejectPair: false }, tx);
        await tx.transaction.deleteMany({ where: { id: { in: added.map((r) => r.id) } } });
        for (const r of rows.filter((x) => has(x, "tax_line_group"))) {
          await releaseLinks([r.id], { rejectPair: false }, tx);
          const original = correctionsOf(r).find((c) => c.kind === "tax_line_group")!.originalReceiptGroupId as string | null;
          await tx.transaction.update({ where: { id: r.id }, data: { receiptGroupId: original, corrections: await drop(tx, r.id, "tax_line_group") } });
        }
        summary.tax_line = added.length;
      }
      if (kinds.includes("legacy_group")) {
        const grouped = rows.filter((r) => has(r, "legacy_group"));
        await releaseLinks(grouped.map((r) => r.id), { rejectPair: false }, tx);
        for (const r of grouped) {
          await tx.transaction.update({ where: { id: r.id }, data: { receiptGroupId: null, corrections: await drop(tx, r.id, "legacy_group") } });
        }
        summary.legacy_group = grouped.length;
      }
      if (kinds.includes("exclude")) {
        const excluded = rows.filter((r) => has(r, "exclude"));
        for (const r of excluded) {
          await tx.transaction.update({ where: { id: r.id }, data: { excludedReason: null, corrections: await drop(tx, r.id, "exclude") } });
        }
        summary.exclude = excluded.length;
      }
      if (kinds.includes("date_fix")) {
        const fixed = rows.filter((r) => has(r, "date_fix"));
        for (const r of fixed) {
          const original = correctionsOf(r).find((c) => c.kind === "date_fix")!.originalDate as string;
          await tx.transaction.update({
            where: { id: r.id },
            data: { date: new Date(`${original}T00:00:00.000Z`), corrections: await drop(tx, r.id, "date_fix") },
          });
        }
        summary.date_fix = fixed.length;
      }
    },
    { timeout: 120_000 }
  );
  const rerun = await runReconciliation({ useAi: false, finalizeCash: false });
  console.log(JSON.stringify({ reverted: summary, backupFile, reconciliation: rerun }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
