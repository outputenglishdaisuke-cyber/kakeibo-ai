import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma";
import {
  DASHBOARD_LAYOUT_KEY,
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayoutItem,
} from "@/lib/dashboard-layout";

const layoutItemSchema = z.object({
  i: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  minW: z.number().optional(),
  minH: z.number().optional(),
  maxW: z.number().optional(),
  maxH: z.number().optional(),
  static: z.boolean().optional(),
});

const putSchema = z.object({
  layout: z.array(layoutItemSchema).min(1),
});

export async function GET() {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: DASHBOARD_LAYOUT_KEY },
    });
    if (!row) {
      return NextResponse.json({
        layout: DEFAULT_DASHBOARD_LAYOUT,
        isDefault: true,
      });
    }
    const layout = Array.isArray(row.value)
      ? (row.value as unknown as DashboardLayoutItem[])
      : DEFAULT_DASHBOARD_LAYOUT;
    return NextResponse.json({ layout, isDefault: false });
  } catch (err) {
    console.error("[settings/dashboard-layout] GET", err);
    return NextResponse.json(
      { layout: DEFAULT_DASHBOARD_LAYOUT, isDefault: true },
      { status: 200 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const layout = parsed.data.layout as DashboardLayoutItem[];
    const value = layout as unknown as Prisma.InputJsonValue;
    await prisma.appSetting.upsert({
      where: { key: DASHBOARD_LAYOUT_KEY },
      create: { key: DASHBOARD_LAYOUT_KEY, value },
      update: { value },
    });

    return NextResponse.json({ layout, isDefault: false });
  } catch (err) {
    console.error("[settings/dashboard-layout] PUT", err);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await prisma.appSetting.deleteMany({
      where: { key: DASHBOARD_LAYOUT_KEY },
    });
    return NextResponse.json({
      layout: DEFAULT_DASHBOARD_LAYOUT,
      isDefault: true,
    });
  } catch (err) {
    console.error("[settings/dashboard-layout] DELETE", err);
    return NextResponse.json({ error: "リセットに失敗しました" }, { status: 500 });
  }
}
