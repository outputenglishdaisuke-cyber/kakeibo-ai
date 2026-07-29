import { prisma } from "../src/lib/prisma";

const apply = process.argv.includes("--apply");

async function main() {
  const rows = await prisma.transaction.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const groups = new Map<string, typeof rows>();

  for (const row of rows) {
    const description = row.description.trim();
    const key = [row.date.toISOString(), description, row.amount].join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const duplicates = [...groups.values()].filter((group) => group.length > 1);
  const deleteCount = duplicates.reduce(
    (total, group) => total + group.length - 1,
    0
  );

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        totalRows: rows.length,
        duplicateGroups: duplicates.length,
        deleteCount,
      },
      null,
      2
    )
  );

  if (!apply || deleteCount === 0) return;

  await prisma.$transaction(
    async (tx) => {
      for (const group of duplicates) {
        // もっとも新しい情報を持つ行を残す（分類や微修正が反映されている可能性が高い）
        const survivor = group.reduce((best, cur) => {
          if (!best) return cur;
          const bestTime = best.updatedAt?.getTime?.() ?? best.createdAt.getTime();
          const curTime = cur.updatedAt?.getTime?.() ?? cur.createdAt.getTime();
          if (curTime > bestTime) return cur;
          if (curTime < bestTime) return best;
          // updatedAt が同じなら createdAt、最後に id
          const bestCreated = best.createdAt.getTime();
          const curCreated = cur.createdAt.getTime();
          if (curCreated > bestCreated) return cur;
          if (curCreated < bestCreated) return best;
          return cur.id > best.id ? cur : best;
        }, group[0]);

        const removed = group.filter((row) => row.id !== survivor.id);
        await tx.transaction.deleteMany({
          where: { id: { in: removed.map((row) => row.id) } },
        });
      }
    },
    { maxWait: 10_000, timeout: 30_000 }
  );

  console.log(`Deleted ${deleteCount} duplicate transaction rows.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

