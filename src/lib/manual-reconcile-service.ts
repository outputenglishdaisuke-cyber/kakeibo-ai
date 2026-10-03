/**
 * 照合画面の手動操作を DB に反映するサービス層。
 * 1操作 = 1トランザクション。対象行を行ロック（FOR UPDATE）してから、画面が見た版（updatedAt）と
 * 現在の状態を確かめ、変わっていれば OperationError(conflict) で全体を巻き戻す。
 * 変更前後の値は ReconcileOperation に保存し、取り消しはそこから元の値に戻す。
 */
import { randomUUID } from "node:crypto";
import type { Prisma, Transaction } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { storeNameOf, type LedgerRow } from "@/lib/reconcile";
import { toLedgerRow } from "@/lib/reconcile-service";
import {
  cardOnlyRuleKey,
  findCardOnlyRule,
  OperationError,
  planCardOnly,
  planCash,
  planDuplicate,
  planLink,
  planUndo,
  planUnknown,
  planUnlink,
  type DiffMode,
  type OperationPlan,
  type RowChange,
} from "@/lib/manual-reconcile";

type Tx = Prisma.TransactionClient;

/** 画面が読み込んだ時点の版。キーは明細の行ID（レシートは代表の行ID）、値は updatedAt（品目分割は最大値） */
export type ExpectedVersions = Record<string, string>;

export type OperationRequest =
  | {
      kind: "link";
      cardIds: string[];
      receiptIds: string[];
      diffMode?: DiffMode | null;
      expected: ExpectedVersions;
    }
  | { kind: "cash"; receiptId: string; expected: ExpectedVersions }
  | {
      kind: "duplicate";
      receiptId: string;
      partnerId: string;
      note?: string | null;
      expected: ExpectedVersions;
    }
  | { kind: "unknown"; id: string; expected: ExpectedVersions }
  | {
      kind: "card_only";
      cardId: string;
      parts: { categoryId: string; amount: number }[];
      createRule?: boolean;
      expected: ExpectedVersions;
    }
  | { kind: "unlink"; cardId: string; expected?: ExpectedVersions }
  | { kind: "undo"; opId: string };

export interface OperationResult {
  opId: string;
  summary: string;
}

const newId = () => randomUUID();

const ACTIVE = { archived: false, deletedAt: null, excludedReason: null, confirmed: true } as const;

async function lockRows(tx: Tx, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "Transaction" WHERE id = ANY(${unique}::text[]) ORDER BY id FOR UPDATE`;
}

/** 行を読み、品目分割のレシートは同じレシートの全行（集計対象の行）に広げる */
async function loadUnit(tx: Tx, id: string): Promise<Transaction[]> {
  const row = await tx.transaction.findUnique({ where: { id } });
  if (!row) throw new OperationError("conflict", "明細が見つかりません。再読み込みしてください");
  if (!row.receiptGroupId || row.source === "CSV") return [row];
  const rows = await tx.transaction.findMany({
    where: { receiptGroupId: row.receiptGroupId, ...ACTIVE },
    orderBy: [{ amount: "desc" }, { id: "asc" }],
  });
  return rows.some((r) => r.id === row.id) ? rows : [row, ...rows];
}

/** 対象の行をロックしてから読み直す（ロック前に読んだ品目分割の構成が変わっていないかも確かめる） */
async function loadLockedUnits(tx: Tx, ids: string[]): Promise<Transaction[][]> {
  await lockRows(tx, ids);
  const first = await Promise.all(ids.map((id) => loadUnit(tx, id)));
  await lockRows(tx, first.flat().map((r) => r.id));
  const units = await Promise.all(ids.map((id) => loadUnit(tx, id)));
  const key = (u: Transaction[][]) => u.map((rows) => rows.map((r) => r.id).sort().join(",")).join("|");
  if (key(first) !== key(units)) {
    throw new OperationError("conflict", "レシートの品目が変更されています。再読み込みしてください");
  }
  return units;
}

export function unitVersion(rows: { updatedAt: Date | string }[]): string {
  return rows
    .map((r) => (typeof r.updatedAt === "string" ? r.updatedAt : r.updatedAt.toISOString()))
    .sort()
    .at(-1)!;
}

function assertVersions(expected: ExpectedVersions | undefined, units: Transaction[][]) {
  if (!expected) return;
  for (const rows of units) {
    const rep = rows.find((r) => r.id in expected);
    if (!rep) continue;
    if (expected[rep.id] !== unitVersion(rows)) {
      throw new OperationError(
        "conflict",
        `「${storeNameOf(rep.description)}」は、画面を開いた後に変更されています。再読み込みしてください`
      );
    }
  }
}

const ledger = (rows: Transaction[]): LedgerRow[] => rows.map(toLedgerRow);

/** 同じ日付・内容・金額の行と重ならない dupIndex（複合一意制約のため） */
async function nextDupIndex(tx: Tx, date: Date, description: string, amount: number) {
  const max = await tx.transaction.aggregate({
    where: { date, description, amount },
    _max: { dupIndex: true },
  });
  return max._max.dupIndex === null ? 0 : max._max.dupIndex + 1;
}

async function persistPlan(
  tx: Tx,
  plan: OperationPlan,
  meta: { opId: string; actor: "user" | "rule"; ruleId?: string | null }
): Promise<OperationResult> {
  for (const c of plan.changes) {
    await tx.transaction.update({ where: { id: c.id }, data: c.after });
  }
  for (const n of plan.creates) {
    const date = new Date(`${n.date.slice(0, 10)}T00:00:00.000Z`);
    await tx.transaction.create({
      data: {
        ...n,
        date,
        confirmed: true,
        dupIndex: await nextDupIndex(tx, date, n.description, n.amount),
      },
    });
  }
  const createdRowIds = plan.creates.map((n) => n.id);
  await tx.reconcileOperation.create({
    data: {
      id: meta.opId,
      kind: plan.kind,
      actor: meta.actor,
      summary: plan.summary,
      rowIds: [...new Set([...plan.changes.map((c) => c.id), ...createdRowIds])],
      changes: plan.changes as unknown as Prisma.InputJsonValue,
      createdRowIds,
      ruleId: meta.ruleId ?? null,
    },
  });
  return { opId: meta.opId, summary: plan.summary };
}

async function categoryNames(tx: Tx, ids: string[]) {
  const rows = await tx.category.findMany({ where: { id: { in: ids } } });
  if (rows.length !== new Set(ids).size) {
    throw new OperationError("invalid", "存在しないカテゴリが指定されています");
  }
  return new Map(rows.map((c) => [c.id, c.name]));
}

async function linkRowsOf(tx: Tx, card: Transaction): Promise<Transaction[]> {
  const where: Prisma.TransactionWhereInput = card.linkId
    ? { OR: [{ linkId: card.linkId }, { matchedCardId: card.id }] }
    : { OR: [{ id: card.id }, { matchedCardId: card.id }] };
  return tx.transaction.findMany({ where: { AND: [where, ACTIVE] } });
}

async function runInTx(tx: Tx, req: OperationRequest, actor: "user" | "rule", ruleId?: string) {
  const opId = newId();
  switch (req.kind) {
    case "link": {
      const units = await loadLockedUnits(tx, [...req.cardIds, ...req.receiptIds]);
      assertVersions(req.expected, units);
      const cards = units.slice(0, req.cardIds.length).flat();
      const receipts = units.slice(req.cardIds.length).map(ledger);
      if (cards.some((c) => c.source !== "CSV") || receipts.flat().some((r) => r.source === "CSV")) {
        throw new OperationError("invalid", "カード明細とレシートの指定が逆です");
      }
      const plan = planLink({ cards: ledger(cards), receipts, diffMode: req.diffMode, opId, newId });
      return persistPlan(tx, plan, { opId, actor });
    }
    case "cash": {
      const [unit] = await loadLockedUnits(tx, [req.receiptId]);
      assertVersions(req.expected, [unit]);
      return persistPlan(tx, planCash(ledger(unit)), { opId, actor });
    }
    case "duplicate": {
      const [unit, partner] = await loadLockedUnits(tx, [req.receiptId, req.partnerId]);
      assertVersions(req.expected, [unit]);
      return persistPlan(tx, planDuplicate(ledger(unit), ledger(partner), req.note), { opId, actor });
    }
    case "unknown": {
      const [unit] = await loadLockedUnits(tx, [req.id]);
      assertVersions(req.expected, [unit]);
      return persistPlan(tx, planUnknown(ledger(unit)), { opId, actor });
    }
    case "card_only": {
      const [unit] = await loadLockedUnits(tx, [req.cardId]);
      assertVersions(req.expected, [unit]);
      const card = unit[0];
      if (card.source !== "CSV") throw new OperationError("invalid", "カード明細を指定してください");
      const names = await categoryNames(tx, req.parts.map((p) => p.categoryId));
      const plan = planCardOnly({
        card: toLedgerRow(card),
        parts: req.parts.map((p) => ({ ...p, categoryName: names.get(p.categoryId) })),
        opId,
        newId,
        viaRule: actor === "rule",
      });
      let createdRuleId = ruleId ?? null;
      if (req.createRule) {
        if (req.parts.length !== 1) {
          throw new OperationError("invalid", "自動確定のルールは、1つのカテゴリで確定するときだけ登録できます");
        }
        const storeKey = cardOnlyRuleKey(card.description);
        const existing = await tx.cardOnlyRule.findFirst({
          where: { storeKey, enabled: true, deletedAt: null },
        });
        if (!existing) {
          const rule = await tx.cardOnlyRule.create({
            data: { storeKey, storeSample: card.description, categoryId: req.parts[0].categoryId },
          });
          createdRuleId = rule.id;
          plan.summary += "。今後この店はレシートなしで自動確定";
        }
      }
      return persistPlan(tx, plan, { opId, actor, ruleId: req.createRule ? createdRuleId : ruleId });
    }
    case "unlink": {
      await lockRows(tx, [req.cardId]);
      const card = await tx.transaction.findUnique({ where: { id: req.cardId } });
      if (!card || card.source !== "CSV") throw new OperationError("conflict", "カード明細が見つかりません");
      const rows = await linkRowsOf(tx, card);
      await lockRows(tx, rows.map((r) => r.id));
      const locked = await linkRowsOf(tx, card);
      if (req.expected?.[card.id] && req.expected[card.id] !== unitVersion([card])) {
        throw new OperationError("conflict", "画面を開いた後に変更されています。再読み込みしてください");
      }
      return persistPlan(tx, planUnlink(ledger(locked)), { opId, actor });
    }
    case "undo": {
      await tx.$queryRaw`SELECT id FROM "ReconcileOperation" WHERE id = ${req.opId} FOR UPDATE`;
      const op = await tx.reconcileOperation.findUnique({ where: { id: req.opId } });
      if (!op) throw new OperationError("invalid", "操作の履歴が見つかりません");
      if (op.kind === "undo") throw new OperationError("invalid", "取り消しの操作は取り消せません");
      if (op.undoneAt) throw new OperationError("conflict", "この操作はすでに取り消されています");
      await lockRows(tx, op.rowIds);
      const current = await tx.transaction.findMany({ where: { id: { in: op.rowIds } } });
      const plan = planUndo(
        {
          id: op.id,
          summary: op.summary,
          changes: op.changes as unknown as RowChange[],
          createdRowIds: op.createdRowIds,
        },
        ledger(current)
      );
      const result = await persistPlan(tx, plan, { opId, actor: "user", ruleId: op.ruleId });
      await tx.reconcileOperation.update({ where: { id: op.id }, data: { undoneAt: new Date() } });
      // 画面の操作で登録したルールは、その操作の取り消しで一緒に外す（ルールによる自動確定の取り消しでは外さない）
      if (op.ruleId && op.actor === "user") {
        await tx.cardOnlyRule.updateMany({
          where: { id: op.ruleId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
      return result;
    }
  }
}

/** 手動操作を1件実行する（1トランザクション。途中で失敗したら全体を巻き戻す） */
export async function executeOperation(
  req: OperationRequest,
  options: { actor?: "user" | "rule"; ruleId?: string } = {}
): Promise<OperationResult> {
  return prisma.$transaction((tx) => runInTx(tx, req, options.actor ?? "user", options.ruleId), {
    timeout: 20_000,
    maxWait: 10_000,
  });
}

/**
 * CSV取込で追加したカード明細のうち、まだ未照合で、レシートなし自動確定のルールに当たるものを確定する。
 * 自動突合の後に呼ぶ（レシートと突合できたものは対象にしない）。1件ずつ別のトランザクションで行う。
 */
export async function applyCardOnlyRules(cardIds: string[]): Promise<{ confirmed: number; failed: number }> {
  if (cardIds.length === 0) return { confirmed: 0, failed: 0 };
  const rules = await prisma.cardOnlyRule.findMany({ where: { enabled: true, deletedAt: null } });
  if (rules.length === 0) return { confirmed: 0, failed: 0 };
  const cards = await prisma.transaction.findMany({
    where: { id: { in: cardIds }, source: "CSV", reconcileStatus: "unmatched", amount: { gt: 0 }, ...ACTIVE },
  });
  let confirmed = 0;
  let failed = 0;
  for (const card of cards) {
    const rule = findCardOnlyRule(card.description, rules);
    if (!rule) continue;
    try {
      await executeOperation(
        {
          kind: "card_only",
          cardId: card.id,
          parts: [{ categoryId: rule.categoryId, amount: card.amount }],
          expected: {},
        },
        { actor: "rule", ruleId: rule.id }
      );
      confirmed += 1;
    } catch (error) {
      console.warn("レシートなし自動確定に失敗しました", card.id, error);
      failed += 1;
    }
  }
  return { confirmed, failed };
}
