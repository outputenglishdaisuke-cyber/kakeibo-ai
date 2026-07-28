import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { getMonthRange } from "@/lib/utils";

const bulkDeleteSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("ids"),
    ids: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    mode: z.literal("month"),
    month: z.string().regex(/^\d{4}-\d{2}$/),
  }),
  z.object({
    mode: z.literal("all"),
  }),
]);

/**
 * 削除前の件数確認用。
 * - ?mode=all → 全件数
 * - ?mode=month&month=YYYY-MM → その月の件数
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const mode = searchParams.get("mode");
  const month = searchParams.get("month");

  if (mode === "month") {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "month=YYYY-MM が必要です" }, { status: 400 });
    }
    const { start, end } = getMonthRange(month);
    const count = await prisma.transaction.count({
      where: { date: { gte: start, lte: end } },
    });
    return NextResponse.json({ mode: "month", month, count });
  }

  if (mode === "all") {
    const count = await prisma.transaction.count();
    return NextResponse.json({ mode: "all", count });
  }

  return NextResponse.json(
    { error: "mode=all または mode=month を指定してください" },
    { status: 400 }
  );
}

/**
 * 取引の一括削除。
 * body.mode:
 * - "ids"   : 指定 ID のみ削除
 * - "month" : 指定月の全件削除
 * - "all"   : 全期間の全件削除
 */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = bulkDeleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const payload = parsed.data;
    let result: { count: number };

    if (payload.mode === "ids") {
      result = await prisma.transaction.deleteMany({
        where: { id: { in: payload.ids } },
      });
    } else if (payload.mode === "month") {
      const { start, end } = getMonthRange(payload.month);
      result = await prisma.transaction.deleteMany({
        where: { date: { gte: start, lte: end } },
      });
    } else {
      result = await prisma.transaction.deleteMany({});
    }

    return NextResponse.json({
      mode: payload.mode,
      deletedCount: result.count,
    });
  } catch (err) {
    console.error("[/api/transactions/bulk] DELETE failed:", err);
    const message = err instanceof Error ? err.message : "一括削除に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
