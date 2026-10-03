import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { isCardOnlySettled, releaseLinks } from "@/lib/reconcile-service";

const CARD_ONLY_LOCKED =
  "レシートなしで確定したカード明細の内訳です。金額・日付の変更や削除は、照合画面の「確定済み」から取り消してから行ってください";

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
  if (
    (parsed.data.amount !== undefined || parsed.data.date !== undefined) &&
    (await isCardOnlySettled([id]))
  ) {
    return NextResponse.json({ error: CARD_ONLY_LOCKED }, { status: 409 });
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
  if (await isCardOnlySettled([id])) {
    return NextResponse.json({ error: CARD_ONLY_LOCKED }, { status: 409 });
  }
  await prisma.$transaction(async (tx) => {
    await releaseLinks([id], { rejectPair: false }, tx);
    await tx.transaction.delete({ where: { id } });
  });
  return new NextResponse(null, { status: 204 });
}
