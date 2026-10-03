/**
 * 店舗ごとのレシート集約状況を一覧する監査スクリプト。
 * npx tsx --env-file=.env.local scripts/audit-receipt-aggregation.ts
 */
import { prisma } from "../src/lib/prisma";
import {
  planReceiptGroup,
  type ConfirmableTransaction,
} from "../src/lib/receipt-aggregation";

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseStoreItem(description: string) {
  const idx = description.indexOf(" / ");
  if (idx <= 0) return null;
  return {
    storeName: description.slice(0, idx).trim(),
    itemName: description.slice(idx + 3).trim(),
  };
}

async function main() {
  const rows = await prisma.transaction.findMany({
    where: { source: "IMAGE", archived: false, confirmed: true },
    include: { category: true },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const parsed = parseStoreItem(row.description);
    if (!parsed) continue;
    const key = `${dateKey(row.date)}|${parsed.storeName}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const report = [...groups.entries()]
    .filter(([, g]) => g.length >= 2)
    .map(([key, group]) => {
      const confirmables: ConfirmableTransaction[] = group.map((row) => {
        const parsed = parseStoreItem(row.description)!;
        return {
          date: dateKey(row.date),
          description: row.description,
          amount: row.amount,
          source: row.source,
          categoryId: row.categoryId,
          categoryName: row.category?.name ?? null,
          storeName: parsed.storeName,
          itemName: parsed.itemName,
          receiptGroupId: `legacy:${key}`,
        };
      });
      const plan = planReceiptGroup(confirmables);
      const cats = new Map<string, number>();
      for (const c of confirmables) {
        const name = c.categoryName ?? "(未分類)";
        cats.set(name, (cats.get(name) ?? 0) + 1);
      }
      return {
        key,
        storeName: confirmables[0].storeName,
        date: confirmables[0].date,
        itemCount: group.length,
        totalAmount: group.reduce((s, g) => s + g.amount, 0),
        categories: Object.fromEntries(cats),
        plan: plan.mode,
        reason: plan.mode === "split" ? plan.reason : undefined,
        aggregateCategory:
          plan.mode === "aggregate" ? plan.categoryName : undefined,
      };
    })
    .sort((a, b) =>
      (a.storeName ?? "").localeCompare(b.storeName ?? "", "ja")
    );

  const focus = ["イオンスタイル", "サミット", "Big-A", "BIG", "ビッグ"];
  const focused = report.filter((r) =>
    focus.some((f) => (r.storeName ?? "").includes(f))
  );

  console.log(
    JSON.stringify(
      {
        multiItemReceiptGroups: report.length,
        wouldAggregate: report.filter((r) => r.plan === "aggregate").length,
        wouldSplit: report.filter((r) => r.plan === "split").length,
        focusStores: focused,
        allStores: report,
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
