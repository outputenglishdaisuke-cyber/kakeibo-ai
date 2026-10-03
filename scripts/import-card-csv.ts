/**
 * カード明細CSVを、画面の取込と同じ処理（/api/import → /api/import/confirm のルートハンドラ）で取り込む。
 * 本番の画面がログイン保護で自動操作できない場合の運用用。DATABASE_URL の DB に書き込む。
 *
 *   npx tsx --env-file=.env.local scripts/import-card-csv.ts ~/Downloads/202610.csv
 *
 * AI（分類・店名判定）が使えない場合も、規則だけで取り込み、判定待ちの組は未判定のまま残す。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as parseCsv } from "../src/app/api/import/route";
import { POST as confirmImport } from "../src/app/api/import/confirm/route";
import { prisma } from "../src/lib/prisma";

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("CSVファイルを指定してください");
  const transactions: unknown[] = [];
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", new Blob([await readFile(file)]), path.basename(file));
    const res = await parseCsv(new NextRequest("http://localhost/api/import", { method: "POST", body: fd }));
    const data = await res.json();
    if (!res.ok) throw new Error(`${path.basename(file)}: ${data.error ?? res.status}`);
    console.error(
      JSON.stringify({
        file: path.basename(file),
        rows: data.transactions.length,
        csvFormat: data.csvFormat,
        paymentMonth: data.paymentMonth,
        coverage: data.coverage,
        warnings: data.warnings,
      })
    );
    transactions.push(...data.transactions);
  }
  const res = await confirmImport(
    new NextRequest("http://localhost/api/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions, autoClassify: true }),
    })
  );
  const data = await res.json();
  console.log(JSON.stringify({ status: res.status, ...data }, null, 2));
  if (!res.ok) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
