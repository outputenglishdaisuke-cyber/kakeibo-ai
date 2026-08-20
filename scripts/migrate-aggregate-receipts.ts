/**
 * 既存の IMAGE 明細を、同一カテゴリのレシート単位で集約する一度きりスクリプト。
 *
 * 【重要】過去データには receiptGroupId が保存されていない。
 * そのため同一レシートの厳密な再構成は不可能。
 * `--allow-heuristic` を付けた場合のみ、次の近似キーでグルーピングする:
 *   source=IMAGE + 購入日(YYYY-MM-DD) + 店名(description の " / " より前)
 *
 * 同じ店・同じ日に複数回会計したレシートは誤って1つにまとまるリスクがある。
 *
 * 使い方:
 *   # 1) バックアップのみ
 *   npx tsx --env-file=.env.local scripts/migrate-aggregate-receipts.ts --backup
 *
 *   # 2) ドライラン（書き込みなし・推奨）
 *   npx tsx --env-file=.env.local scripts/migrate-aggregate-receipts.ts --allow-heuristic
 *
 *   # 3) 本実行（バックアップ自動作成 + 書き込み）
 *   npx tsx --env-file=.env.local scripts/migrate-aggregate-receipts.ts --allow-heuristic --apply
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import {
  buildReceiptItemsMemo,
  parseReceiptItemsMemo,
  planReceiptGroup,
  type ConfirmableTransaction,
} from "../src/lib/receipt-aggregation";

const args = new Set(process.argv.slice(2));
const doBackup = args.has("--backup") || args.has("--apply");
const allowHeuristic = args.has("--allow-heuristic");
const apply = args.has("--apply");

type TxRow = Awaited<
  ReturnType<typeof prisma.transaction.findMany>
>[number] & {
  category?: { id: string; name: string; color: string } | null;
};

function dateKey(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 「店名 / 品目」形式だけを候補にする */
function parseStoreItem(
  description: string
): { storeName: string; itemName: string } | null {
  const idx = description.indexOf(" / ");
  if (idx <= 0) return null;
  const storeName = description.slice(0, idx).trim();
  const itemName = description.slice(idx + 3).trim();
  if (!storeName || !itemName) return null;
  return { storeName, itemName };
}

function toConfirmable(row: TxRow): ConfirmableTransaction | null {
  const parsed = parseStoreItem(row.description);
  if (!parsed) return null;
  return {
    date: dateKey(row.date),
    description: row.description,
    amount: row.amount,
    source: row.source,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    categoryColor: row.category?.color ?? null,
    storeName: parsed.storeName,
    itemName: parsed.itemName,
    // ヒューリスティック用の疑似グループID
    receiptGroupId: `legacy:${dateKey(row.date)}:${parsed.storeName}`,
  };
}

async function backupTransactions(label: string) {
  const rows = await prisma.transaction.findMany({
    include: { category: true },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const dir = path.join(process.cwd(), "backups");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `transactions-${label}-${stamp}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        count: rows.length,
        transactions: rows,
      },
      null,
      2
    ),
    "utf8"
  );
  return { file, count: rows.length };
}

async function main() {
  console.log(
    JSON.stringify(
      {
        note: "Transaction テーブルに receiptGroupId / storeName / itemName カラムは存在しません。過去の confirm 保存時もこれらは破棄されていました。",
        grouping: allowHeuristic
          ? "heuristic: IMAGE + date(UTC) + storeName(from description)"
          : "disabled (pass --allow-heuristic to evaluate candidates)",
        mode: apply ? "apply" : "dry-run",
      },
      null,
      2
    )
  );

  if (doBackup) {
    const backup = await backupTransactions(apply ? "pre-apply" : "manual");
    console.log(JSON.stringify({ backup }, null, 2));
    if (args.has("--backup") && !allowHeuristic && !apply) {
      return;
    }
  }

  if (!allowHeuristic) {
    console.log(
      JSON.stringify(
        {
          status: "stopped",
          reason:
            "厳密なレシートIDが無いため、推測グルーピングなしでは移行対象を特定できません。ドライランを見る場合は --allow-heuristic を付けて再実行してください。",
        },
        null,
        2
      )
    );
    return;
  }

  if (apply && !doBackup) {
    throw new Error("--apply にはバックアップが必須です");
  }

  const rows = (await prisma.transaction.findMany({
    where: {
      source: "IMAGE",
      archived: false,
      confirmed: true,
    },
    include: { category: true },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  })) as TxRow[];

  const alreadyAggregated = rows.filter((r) => parseReceiptItemsMemo(r.memo));
  const candidates = rows.filter((r) => !parseReceiptItemsMemo(r.memo));

  const groups = new Map<string, TxRow[]>();
  let skippedNotLineItem = 0;

  for (const row of candidates) {
    const confirmable = toConfirmable(row);
    if (!confirmable?.receiptGroupId) {
      skippedNotLineItem += 1;
      continue;
    }
    const list = groups.get(confirmable.receiptGroupId) ?? [];
    list.push(row);
    groups.set(confirmable.receiptGroupId, list);
  }

  const plans: Array<{
    key: string;
    mode: "aggregate" | "split";
    reason?: string;
    storeName: string;
    date: string;
    itemCount: number;
    totalAmount: number;
    categoryName: string | null;
    sampleItems: string[];
    transactionIds: string[];
  }> = [];

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const confirmables = group
      .map((row) => toConfirmable(row))
      .filter((x): x is ConfirmableTransaction => x != null);
    const plan = planReceiptGroup(confirmables);
    const storeName = confirmables[0]?.storeName ?? group[0].description;
    plans.push({
      key,
      mode: plan.mode,
      reason: plan.mode === "split" ? plan.reason : undefined,
      storeName,
      date: dateKey(group[0].date),
      itemCount: group.length,
      totalAmount: group.reduce((s, g) => s + g.amount, 0),
      categoryName:
        plan.mode === "aggregate"
          ? plan.categoryName
          : group[0].category?.name ?? null,
      sampleItems: group.slice(0, 8).map((g) => g.description),
      transactionIds: group.map((g) => g.id),
    });
  }

  const aggregateTargets = plans.filter((p) => p.mode === "aggregate");
  const splitTargets = plans.filter((p) => p.mode === "split");

  console.log(
    JSON.stringify(
      {
        scannedImageRows: rows.length,
        alreadyAggregatedRows: alreadyAggregated.length,
        skippedNotLineItem,
        candidateGroups: plans.length,
        aggregateReceiptCount: aggregateTargets.length,
        splitReceiptCount: splitTargets.length,
        rowsToArchiveIfApplied: aggregateTargets.reduce(
          (s, p) => s + p.itemCount,
          0
        ),
        aggregatedRowsToCreate: aggregateTargets.length,
        aggregateReceipts: aggregateTargets.map((p) => ({
          storeName: p.storeName,
          date: p.date,
          categoryName: p.categoryName,
          itemCount: p.itemCount,
          totalAmount: p.totalAmount,
          sampleItems: p.sampleItems,
        })),
        splitReceiptsSample: splitTargets.slice(0, 20).map((p) => ({
          storeName: p.storeName,
          date: p.date,
          reason: p.reason,
          itemCount: p.itemCount,
          totalAmount: p.totalAmount,
        })),
        warning:
          "同一店舗・同一購入日の複数レシートは1グループに誤結合される可能性があります。一覧を確認してから --apply してください。",
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          next:
            aggregateTargets.length > 0
              ? "問題なければ同じコマンドに --apply を付けて本実行してください（バックアップも自動作成されます）。"
              : "集約対象はありません。",
        },
        null,
        2
      )
    );
    return;
  }

  let created = 0;
  let archived = 0;

  await prisma.$transaction(
    async (tx) => {
      for (const plan of aggregateTargets) {
        const group = plan.transactionIds
          .map((id) => rows.find((r) => r.id === id)!)
          .filter(Boolean);
        const confirmables = group
          .map((row) => {
            const c = toConfirmable(row);
            if (!c) return null;
            return c;
          })
          .filter((x): x is ConfirmableTransaction => x != null);

        const decided = planReceiptGroup(confirmables);
        if (decided.mode !== "aggregate") continue;

        const memo = buildReceiptItemsMemo(
          confirmables,
          decided.storeName,
          decided.receiptGroupId
        );
        const memoPayload = JSON.parse(memo) as {
          type: "receipt_items";
          receiptGroupId: string;
          storeName: string;
          items: Array<{
            itemName: string;
            amount: number;
            categoryId?: string | null;
            categoryName?: string | null;
            originalId?: string;
          }>;
        };
        memoPayload.items = memoPayload.items.map((item, i) => ({
          ...item,
          originalId: group[i]?.id,
        }));

        const parent = await tx.transaction.create({
          data: {
            date: group[0].date,
            description: decided.storeName,
            amount: decided.totalAmount,
            source: "IMAGE",
            categoryId: decided.categoryId,
            confirmed: true,
            archived: false,
            memo: JSON.stringify(memoPayload),
          },
        });
        created += 1;

        for (const row of group) {
          await tx.transaction.update({
            where: { id: row.id },
            data: {
              archived: true,
              memo: JSON.stringify({
                type: "receipt_line_archived",
                aggregatedIntoId: parent.id,
                storeName: decided.storeName,
                receiptGroupId: decided.receiptGroupId,
              }),
            },
          });
          archived += 1;
        }
      }
    },
    { maxWait: 20_000, timeout: 120_000 }
  );

  const postBackup = await backupTransactions("post-apply");
  console.log(
    JSON.stringify(
      {
        applied: true,
        createdAggregatedRows: created,
        archivedLineItems: archived,
        postBackup,
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
