import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyTransactions } from "@/lib/classifiers";
import { z } from "zod";

const schema = z.object({
  transactionIds: z.array(z.string()),
});

/**
 * 既存の取引を AI で再分類するエンドポイント。
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const transactions = await prisma.transaction.findMany({
    where: { id: { in: parsed.data.transactionIds } },
  });

  const categories = await prisma.category.findMany();

  const results = await classifyTransactions(
    transactions.map((tx) => ({ description: tx.description, amount: tx.amount })),
    categories
  );

  // 結果をDBに反映
  const updated = await prisma.$transaction(
    results.map((result, i) => {
      const tx = transactions[i] as typeof transactions[number];
      return prisma.transaction.update({
        where: { id: tx.id },
        data: { categoryId: result.suggestedCategoryId ?? null },
        include: { category: true },
      });
    })
  );

  return NextResponse.json({ updated });
}
