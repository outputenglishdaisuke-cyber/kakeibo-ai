import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { classifyTransactions } from "@/lib/classifiers";
import { z } from "zod";

const transactionSchema = z.object({
  date: z.string().min(1),
  description: z.string().min(1),
  amount: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: "amount must be non-zero" }),
  source: z.enum(["CSV", "MANUAL", "IMAGE"]).default("CSV"),
});

const confirmSchema = z.object({
  transactions: z.array(transactionSchema).min(1),
  autoClassify: z.boolean().default(true),
});

function parseDate(raw: string): Date | null {
  // YYYY-MM-DD（CSV解析後の正規化形式）または Date パース可能な文字列
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * ユーザーが確認済みの取引リストを DB に保存する。
 * autoClassify=true の場合は AI で自動分類する。
 *
 * 件数が多い場合でもタイムアウトしないよう createManyAndReturn で一括 INSERT する。
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { transactions, autoClassify } = parsed.data;

    // 日付の妥当性チェック
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

    const categories = await prisma.category.findMany();
    const categoryIdSet = new Set(categories.map((c) => c.id));
    const rules = await prisma.rule.findMany({ include: { category: true } });

    // ルールベースの分類を先に適用
    const categorized = transactions.map((tx) => {
      const matched = rules
        .filter((r) =>
          tx.description.toLowerCase().includes(r.keyword.toLowerCase())
        )
        .sort((a, b) => b.priority - a.priority)[0];

      const categoryId =
        matched?.categoryId && categoryIdSet.has(matched.categoryId)
          ? matched.categoryId
          : null;

      return {
        ...tx,
        dateObj: parseDate(tx.date)!,
        categoryId,
      };
    });

    // ルールでカバーできなかった取引を AI で分類
    if (autoClassify && categories.length > 0) {
      const uncategorizedIndices = categorized
        .map((tx, i) => (tx.categoryId === null ? i : -1))
        .filter((i) => i !== -1);

      if (uncategorizedIndices.length > 0) {
        // API のトークン制限を避けるため、一定件数ずつ分類
        const CHUNK = 40;
        for (let offset = 0; offset < uncategorizedIndices.length; offset += CHUNK) {
          const chunkIndices = uncategorizedIndices.slice(offset, offset + CHUNK);
          const chunk = chunkIndices.map((i) => categorized[i]);
          const results = await classifyTransactions(
            chunk.map((tx) => ({ description: tx.description, amount: tx.amount })),
            categories
          );

          results.forEach((result, j) => {
            const idx = chunkIndices[j];
            const id = result.suggestedCategoryId;
            // 存在しないカテゴリ ID は無視（FK 違反防止）
            if (id && categoryIdSet.has(id)) {
              categorized[idx].categoryId = id;
            }
          });
        }
      }
    }

    // 一括 INSERT（インタラクティブトランザクションの 5 秒制限を回避）
    const created = await prisma.transaction.createManyAndReturn({
      data: categorized.map((tx) => ({
        date: tx.dateObj,
        description: tx.description,
        amount: tx.amount,
        source: tx.source,
        categoryId: tx.categoryId,
        confirmed: true,
      })),
    });

    // カテゴリ情報を付与して返す
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const withCategory = created.map((tx) => ({
      ...tx,
      category: tx.categoryId ? categoryById.get(tx.categoryId) ?? null : null,
    }));

    return NextResponse.json(
      { count: created.length, transactions: withCategory },
      { status: 201 }
    );
  } catch (err) {
    console.error("[/api/import/confirm] failed:", err);
    const message =
      err instanceof Error ? err.message : "保存に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
