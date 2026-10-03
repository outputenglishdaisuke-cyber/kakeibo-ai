import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { releaseLinks } from "@/lib/reconcile-service";

const updateSchema = z.object({
  date: z.string().optional(),
  description: z.string().min(1).optional(),
  amount: z.number().int().positive().optional(),
  categoryId: z.string().optional().nullable(),
  memo: z.string().optional().nullable(),
  confirmed: z.boolean().optional(),
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

  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.date) {
    data.date = new Date(parsed.data.date);
  }

  const transaction = await prisma.$transaction(async (tx) => {
    // 突合は金額の完全一致が前提のため、金額を変えたら紐付けを外す
    if (parsed.data.amount !== undefined) {
      const current = await tx.transaction.findUnique({ where: { id } });
      if (current && current.amount !== parsed.data.amount) {
        await releaseLinks([id], { rejectPair: false }, tx);
      }
    }
    return tx.transaction.update({
      where: { id },
      data,
      include: { category: true },
    });
  });
  return NextResponse.json(transaction);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await prisma.$transaction(async (tx) => {
    await releaseLinks([id], { rejectPair: false }, tx);
    await tx.transaction.delete({ where: { id } });
  });
  return new NextResponse(null, { status: 204 });
}
