import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { getMonthRange } from "@/lib/utils";

const createSchema = z.object({
  date: z.string(),
  description: z.string().min(1),
  amount: z.number().int().positive(),
  categoryId: z.string().optional().nullable(),
  source: z.enum(["CSV", "MANUAL", "IMAGE"]).default("MANUAL"),
  memo: z.string().optional().nullable(),
  confirmed: z.boolean().default(false),
});

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const month = searchParams.get("month"); // YYYY-MM
  const categoryId = searchParams.get("categoryId");

  const where: Record<string, unknown> = {};

  if (month) {
    const { start, end } = getMonthRange(month);
    where.date = { gte: start, lte: end };
  }
  if (categoryId) {
    where.categoryId = categoryId === "null" ? null : categoryId;
  }

  const transactions = await prisma.transaction.findMany({
    where,
    include: { category: true },
    orderBy: { date: "desc" },
  });

  return NextResponse.json(transactions);
}

export async function POST(req: NextRequest) {
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
}
