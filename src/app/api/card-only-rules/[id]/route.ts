import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const patchSchema = z.object({ enabled: z.boolean() });

/** 有効・無効の切り替え */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await prisma.cardOnlyRule.updateMany({
    where: { id, deletedAt: null },
    data: { enabled: parsed.data.enabled },
  });
  if (result.count === 0) return NextResponse.json({ error: "ルールが見つかりません" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** 削除（行は残し deletedAt を入れる。既に自動確定した明細はそのまま） */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await prisma.cardOnlyRule.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date(), enabled: false },
  });
  return new NextResponse(null, { status: 204 });
}
