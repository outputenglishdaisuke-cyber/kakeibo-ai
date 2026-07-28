import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const ruleSchema = z.object({
  keyword: z.string().min(1).max(100),
  categoryId: z.string(),
  priority: z.number().int().default(0),
});

export async function GET() {
  const rules = await prisma.rule.findMany({
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    include: { category: true },
  });
  return NextResponse.json(rules);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const rule = await prisma.rule.create({
    data: parsed.data,
    include: { category: true },
  });
  return NextResponse.json(rule, { status: 201 });
}
