import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyTransactions } from "@/lib/classifiers";
import { z } from "zod";

const transactionSchema = z.object({
  date: z.string(),
  description: z.string(),
  amount: z.number().int().refine((n) => n !== 0, { message: "amount must be non-zero" }),
  source: z.enum(["CSV", "MANUAL", "IMAGE"]).default("CSV"),
});

const confirmSchema = z.object({
  transactions: z.array(transactionSchema),
  autoClassify: z.boolean().default(true),
});

/**
 * ユーザーが確認済みの取引リストを DB に保存する。
 * autoClassify=true の場合は AI で自動分類する。
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { transactions, autoClassify } = parsed.data;
  const categories = await prisma.category.findMany();
  const rules = await prisma.rule.findMany({ include: { category: true } });

  // ルールベースの分類を先に適用
  const categorized = transactions.map((tx) => {
    const matched = rules
      .filter((r: { keyword: string }) => tx.description.toLowerCase().includes(r.keyword.toLowerCase()))
      .sort((a: { priority: number }, b: { priority: number }) => b.priority - a.priority)[0];

    return {
      ...tx,
      categoryId: matched?.categoryId ?? null,
    };
  });

  // ルールでカバーできなかった取引を AI で分類
  if (autoClassify && categories.length > 0) {
    const uncategorizedIndices = categorized
      .map((tx, i) => (tx.categoryId === null ? i : -1))
      .filter((i) => i !== -1);

    if (uncategorizedIndices.length > 0) {
      const uncategorized = uncategorizedIndices.map((i) => categorized[i]);
      const results = await classifyTransactions(
        uncategorized.map((tx) => ({ description: tx.description, amount: tx.amount })),
        categories
      );

      results.forEach((result, j) => {
        const idx = uncategorizedIndices[j];
        if (result.suggestedCategoryId) {
          categorized[idx].categoryId = result.suggestedCategoryId;
        }
      });
    }
  }

  // DB に一括保存（confirmed=true でユーザー確認済みとしてマーク）
  const created = await prisma.$transaction(
    categorized.map((tx) =>
      prisma.transaction.create({
        data: {
          date: new Date(tx.date),
          description: tx.description,
          amount: tx.amount,
          source: tx.source,
          categoryId: tx.categoryId,
          confirmed: true,
        },
        include: { category: true },
      })
    )
  );

  return NextResponse.json({ count: created.length, transactions: created }, { status: 201 });
}
