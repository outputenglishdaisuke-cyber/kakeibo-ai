import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { getMonthRange } from "@/lib/utils";
import type { Prisma, Source } from "@/generated/prisma";

const createSchema = z.object({
  date: z.string(),
  description: z.string().trim().min(1),
  amount: z.number().int().positive(),
  categoryId: z.string().optional().nullable(),
  source: z.enum(["CSV", "MANUAL", "IMAGE"]).default("MANUAL"),
  memo: z.string().optional().nullable(),
  confirmed: z.boolean().default(false),
});

const VALID_SOURCES = new Set(["CSV", "MANUAL", "IMAGE"]);

function isUniqueConstraintError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const month = searchParams.get("month"); // YYYY-MM
  const categoriesParam = searchParams.get("categories"); // id1,id2,uncategorized
  const sourcesParam = searchParams.get("sources"); // CSV,IMAGE,MANUAL
  // 後方互換
  const legacyCategoryId = searchParams.get("categoryId");

  const where: Prisma.TransactionWhereInput = {};

  if (month) {
    const { start, end } = getMonthRange(month);
    where.date = { gte: start, lte: end };
  }

  if (categoriesParam) {
    const parts = categoriesParam.split(",").map((s) => s.trim()).filter(Boolean);
    const includeUncategorized = parts.some(
      (p) => p === "uncategorized" || p === "null"
    );
    const ids = parts.filter((p) => p !== "uncategorized" && p !== "null");
    const or: Prisma.TransactionWhereInput[] = [];
    if (ids.length > 0) {
      or.push({ categoryId: { in: ids } });
    }
    if (includeUncategorized) {
      or.push({ categoryId: null });
    }
    if (or.length === 1) {
      Object.assign(where, or[0]);
    } else if (or.length > 1) {
      where.OR = or;
    }
  } else if (legacyCategoryId) {
    where.categoryId = legacyCategoryId === "null" ? null : legacyCategoryId;
  }

  if (sourcesParam) {
    const sources = sourcesParam
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Source => VALID_SOURCES.has(s));
    if (sources.length > 0) {
      where.source = { in: sources };
    }
  }

  const transactions = await prisma.transaction.findMany({
    where,
    include: { category: true },
    orderBy: { date: "desc" },
  });

  return NextResponse.json(transactions);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const transaction = await prisma.transaction.create({
      data: {
        ...parsed.data,
        date: new Date(parsed.data.date),
      },
      include: { category: true },
    });

    return NextResponse.json(transaction, { status: 201 });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return NextResponse.json(
        { error: "同じ日付・店名・金額の明細がすでに登録されています" },
        { status: 409 }
      );
    }
    console.error("[/api/transactions] POST failed:", error);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}
