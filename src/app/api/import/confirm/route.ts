import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyParsedTransactions } from "@/lib/classify-pipeline";
import { ensureDefaultCategories } from "@/lib/default-categories";
import { aggregateSameCategoryReceipts } from "@/lib/receipt-aggregation";
import {
  assignDuplicateIndexes,
  describeImportCoverage,
  initialReconcileFields,
} from "@/lib/reconcile";
import { runReconciliation, type ReconcileRunResult } from "@/lib/reconcile-service";
import { applyCardOnlyRules } from "@/lib/manual-reconcile-service";
import type { Prisma } from "@/generated/prisma";
import { z } from "zod";

// CSV 取込後の店名判定で Web 検索つきの AI を呼ぶため長めに取る
export const maxDuration = 300;

const transactionSchema = z.object({
  date: z.string().min(1),
  description: z.string().trim().min(1),
  amount: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: "amount must be non-zero" }),
  source: z.enum(["CSV", "MANUAL", "IMAGE"]).default("CSV"),
  categoryId: z.string().nullable().optional(),
  categoryName: z.string().nullable().optional(),
  categoryColor: z.string().nullable().optional(),
  receiptGroupId: z.string().nullable().optional(),
  storeName: z.string().nullable().optional(),
  itemName: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  paymentMethod: z.enum(["credit_card", "cash", "unknown"]).nullable().optional(),
  importFileName: z.string().nullable().optional(),
  paymentMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .nullable()
    .optional(),
  csvFormat: z.string().nullable().optional(),
});

const confirmSchema = z.object({
  transactions: z.array(transactionSchema).min(1),
  autoClassify: z.boolean().default(true),
});

function parseDate(raw: string): Date | null {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    );
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 確認済みの取引を DB に保存する。
 * クライアント側で選んだ categoryId を優先し、未設定ならルール → AI で補完する。
 * 同一レシートで全品が同一カテゴリなら店名＋合計の1件にまとめ、品目内訳は memo に残す。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { transactions, autoClassify } = parsed.data;

    const invalidDates = transactions
      .map((tx, i) => ({ i, date: tx.date, parsed: parseDate(tx.date) }))
      .filter((x) => x.parsed === null);
    if (invalidDates.length > 0) {
      return NextResponse.json(
        {
          error: "日付の形式が不正な明細があります",
          samples: invalidDates
            .slice(0, 5)
            .map((x) => ({ index: x.i, date: x.date })),
        },
        { status: 400 }
      );
    }

    const categories = await ensureDefaultCategories();
    const categoryIdSet = new Set(categories.map((c) => c.id));
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    const withClientCategory = transactions.map((tx) => {
      const categoryId =
        tx.categoryId && categoryIdSet.has(tx.categoryId) ? tx.categoryId : null;
      const cat = categoryId ? categoryById.get(categoryId) : null;
      return {
        ...tx,
        categoryId,
        categoryName: cat?.name ?? tx.categoryName ?? null,
        categoryColor: cat?.color ?? tx.categoryColor ?? null,
      };
    });

    const needClassify = withClientCategory.some((tx) => tx.categoryId === null);
    let finalized = withClientCategory;

    if (needClassify) {
      const classified = await classifyParsedTransactions(
        withClientCategory.map((tx) => ({
          date: tx.date,
          description: tx.description,
          amount: tx.amount,
          source: tx.source,
        })),
        { autoClassify }
      );

      finalized = withClientCategory.map((tx, i) => {
        if (tx.categoryId) return tx;
        const c = classified[i];
        const cat = c?.categoryId ? categoryById.get(c.categoryId) : null;
        return {
          ...tx,
          categoryId: c?.categoryId ?? null,
          categoryName: cat?.name ?? c?.categoryName ?? null,
          categoryColor: cat?.color ?? null,
        };
      });
    }

    const inputCount = finalized.length;
    const csvRows = finalized.filter((tx) => tx.source === "CSV");
    const otherRows = aggregateSameCategoryReceipts(
      finalized.filter((tx) => tx.source !== "CSV")
    );
    const aggregatedCount = inputCount - csvRows.length - otherRows.length;

    // CSV はファイルごとに「同日・同店・同額の何件目か」を付け、同じ明細の重複取込だけを除外する
    const csvByFile = new Map<string, typeof csvRows>();
    for (const tx of csvRows) {
      const key = tx.importFileName ?? "";
      csvByFile.set(key, [...(csvByFile.get(key) ?? []), tx]);
    }

    const { created, batchIds } = await prisma.$transaction(async (db) => {
      const batchIds: string[] = [];
      const rows: Prisma.TransactionCreateManyInput[] = [];
      for (const [fileName, fileRows] of csvByFile) {
        const batch = await db.cardImportBatch.create({
          data: {
            fileName: fileName || null,
            format: fileRows[0].csvFormat ?? null,
            paymentMonth: fileRows[0].paymentMonth ?? null,
          },
        });
        batchIds.push(batch.id);
        for (const tx of assignDuplicateIndexes(fileRows)) {
          rows.push({
            date: parseDate(tx.date)!,
            description: tx.description,
            amount: tx.amount,
            source: tx.source,
            categoryId: tx.categoryId,
            memo: tx.memo ?? null,
            confirmed: true,
            receiptGroupId: null,
            importBatchId: batch.id,
            dupIndex: tx.dupIndex,
            ...initialReconcileFields(tx.source, tx.amount, tx.paymentMethod),
          });
        }
      }
      for (const tx of otherRows) {
        rows.push({
          date: parseDate(tx.date)!,
          description: tx.description,
          amount: tx.amount,
          source: tx.source,
          categoryId: tx.categoryId,
          memo: tx.memo ?? null,
          confirmed: true,
          receiptGroupId: tx.receiptGroupId ?? null,
          ...initialReconcileFields(tx.source, tx.amount, tx.paymentMethod),
        });
      }

      const created = await db.transaction.createManyAndReturn({
        data: rows,
        // DB の複合一意制約と併用し、既存DB・同一リクエスト内の重複を除外する。
        skipDuplicates: true,
      });

      for (const id of batchIds) {
        const dates = created
          .filter((tx) => tx.importBatchId === id)
          .map((tx) => tx.date.getTime())
          .sort((a, b) => a - b);
        if (dates.length === 0) {
          await db.cardImportBatch.delete({ where: { id } });
          continue;
        }
        await db.cardImportBatch.update({
          where: { id },
          data: {
            rowCount: dates.length,
            coverageStart: new Date(dates[0]),
            coverageEnd: new Date(dates[dates.length - 1]),
          },
        });
      }
      return { created, batchIds };
    });
    const skippedCount = csvRows.length + otherRows.length - created.length;

    // CSV 取込完了時: 突合（AI 判定つき）→ 現金への自動判定 → レシートなし自動確定のルール。レシート保存時: 突合のみ。
    let reconcile: ReconcileRunResult | { error: string } | null = null;
    let cardOnlyAuto: { confirmed: number; failed: number } | null = null;
    if (created.length > 0) {
      const hasCard = created.some((tx) => tx.source === "CSV");
      try {
        reconcile = await runReconciliation({ useAi: hasCard, finalizeCash: hasCard });
      } catch (err) {
        console.error("[/api/import/confirm] reconcile failed:", err);
        reconcile = {
          error: err instanceof Error ? err.message : "突合に失敗しました",
        };
      }
      if (hasCard) {
        cardOnlyAuto = await applyCardOnlyRules(
          created.filter((tx) => tx.source === "CSV").map((tx) => tx.id)
        ).catch((err) => {
          console.error("[/api/import/confirm] card-only rules failed:", err);
          return null;
        });
      }
    }

    const withCategory = created.map((tx) => ({
      ...tx,
      category: tx.categoryId ? categoryById.get(tx.categoryId) ?? null : null,
    }));

    // 取込完了時: CSVの利用日の範囲と、未照合レシートの期間とのずれを知らせる
    let coverageNotices: { fileName: string | null; message: string; warning: string | null }[] = [];
    if (csvByFile.size > 0) {
      const unmatchedReceipts = await prisma.transaction.findMany({
        where: { source: { not: "CSV" }, reconcileStatus: "unmatched" },
        select: { date: true },
      });
      const unmatchedReceiptDates = unmatchedReceipts.map((r) => r.date.toISOString().slice(0, 10));
      coverageNotices = [...csvByFile].flatMap(([fileName, fileRows]) => {
        const info = describeImportCoverage({
          fileName: fileName || null,
          paymentMonth: fileRows[0].paymentMonth ?? null,
          dates: fileRows.map((tx) => tx.date),
          unmatchedReceiptDates,
        });
        return info ? [{ fileName: fileName || null, message: info.message, warning: info.warning }] : [];
      });
    }

    return NextResponse.json(
      {
        count: created.length,
        skippedCount,
        inputCount,
        aggregatedCount: Math.max(0, aggregatedCount),
        transactions: withCategory,
        reconcile,
        cardOnlyAuto,
        importBatchIds: batchIds,
        coverageNotices,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[/api/import/confirm] failed:", err);
    const message =
      err instanceof Error ? err.message : "保存に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
