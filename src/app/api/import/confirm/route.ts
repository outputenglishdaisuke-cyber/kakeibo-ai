import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyParsedTransactions } from "@/lib/classify-pipeline";
import { ensureDefaultCategories } from "@/lib/default-categories";
import { z } from "zod";

const transactionSchema = z.object({
  date: z.string().min(1),
  description: z.string().trim().min(1),
  amount: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: "amount must be non-zero" }),
  source: z.enum(["CSV", "MANUAL", "IMAGE"]).default("CSV"),
  categoryId: z.string().nullable().optional(),
});

const confirmSchema = z.object({
  transactions: z.array(transactionSchema).min(1),
  autoClassify: z.boolean().default(true),
});

function parseDate(raw: string): Date | null {
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 確認済みの取引を DB に保存する。
 * クライアント側で選んだ categoryId を優先し、未設定ならルール → AI で補完する。
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
          samples: invalidDates.slice(0, 5).map((x) => ({ index: x.i, date: x.date })),
        },
        { status: 400 }
      );
    }

    const categories = await ensureDefaultCategories();
    const categoryIdSet = new Set(categories.map((c) => c.id));
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    // クライアント指定の categoryId を検証
    const withClientCategory = transactions.map((tx) => ({
      ...tx,
      categoryId:
        tx.categoryId && categoryIdSet.has(tx.categoryId) ? tx.categoryId : null,
    }));

    // 未分類のみルール → AI
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
        return {
          ...tx,
          categoryId: c?.categoryId ?? null,
        };
      });
    }

    const created = await prisma.transaction.createManyAndReturn({
      data: finalized.map((tx) => ({
        date: parseDate(tx.date)!,
        description: tx.description,
        amount: tx.amount,
        source: tx.source,
        categoryId: tx.categoryId,
        confirmed: true,
      })),
      // DB の複合一意制約と併用し、既存DB・同一リクエスト内の重複を除外する。
      skipDuplicates: true,
    });
    const skippedCount = finalized.length - created.length;

    const withCategory = created.map((tx) => ({
      ...tx,
      category: tx.categoryId ? categoryById.get(tx.categoryId) ?? null : null,
    }));

    return NextResponse.json(
      {
        count: created.length,
        skippedCount,
        transactions: withCategory,
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
