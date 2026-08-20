/**
 * Transaction 全件を JSON バックアップする。
 * npx tsx --env-file=.env.local scripts/backup-transactions.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";

async function main() {
  const label = process.argv[2] || "manual";
  // archived 未適用環境でも動くよう raw で取得
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT * FROM "Transaction" ORDER BY "date" ASC, "createdAt" ASC, "id" ASC`
  );
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
  console.log(JSON.stringify({ ok: true, file, count: rows.length }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
