import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** レシートなし自動確定のルール一覧（削除したものは除く） */
export async function GET() {
  const rules = await prisma.cardOnlyRule.findMany({
    where: { deletedAt: null },
    include: { category: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(rules);
}
