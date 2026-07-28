import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const updateSchema = z.object({
  keyword: z.string().min(1).max(100).optional(),
  categoryId: z.string().optional(),
  priority: z.number().int().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const rule = await prisma.rule.update({
    where: { id },
    data: parsed.data,
    include: { category: true },
  });
  return NextResponse.json(rule);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.rule.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
