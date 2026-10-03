import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getMonthKey } from "@/lib/utils";
import {
  deleteUnknown,
  getReconcileView,
  markUnknown,
  revertAutoCash,
  runReconciliation,
  saveJudgement,
  unlinkMatch,
} from "@/lib/reconcile-service";

const MONTH_RE = /^\d{4}-\d{2}$/;

const ids = z.array(z.string().min(1)).min(1);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unlink"), cardId: z.string().min(1) }),
  z.object({ action: z.literal("revert_cash"), ids }),
  z.object({ action: z.literal("mark_unknown"), ids }),
  z.object({ action: z.literal("delete_unknown"), ids }),
  z.object({
    action: z.literal("teach"),
    cardName: z.string().trim().min(1),
    receiptName: z.string().trim().min(1),
    verdict: z.enum(["same", "different"]),
    note: z.string().trim().max(200).nullable().optional(),
  }),
  z.object({ action: z.literal("rerun") }),
]);

/** 照合画面のデータ（?month=YYYY-MM） */
export async function GET(req: NextRequest) {
  try {
    const requested = req.nextUrl.searchParams.get("month");
    const month = requested && MONTH_RE.test(requested) ? requested : getMonthKey(new Date());
    return NextResponse.json(await getReconcileView(month));
  } catch (error) {
    console.error("[/api/reconcile] GET failed:", error);
    return NextResponse.json({ error: "照合データの取得に失敗しました" }, { status: 500 });
  }
}

/** 紐付け解除・現金の取り消し・Unknown・店名の教育などの操作 */
export async function POST(req: NextRequest) {
  try {
    const parsed = actionSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    switch (body.action) {
      case "unlink":
        return NextResponse.json({ released: await unlinkMatch(body.cardId) });
      case "revert_cash":
        return NextResponse.json(await revertAutoCash(body.ids));
      case "mark_unknown":
        return NextResponse.json(await markUnknown(body.ids));
      case "delete_unknown":
        return NextResponse.json(await deleteUnknown(body.ids));
      case "teach": {
        await saveJudgement({
          cardSample: body.cardName,
          receiptSample: body.receiptName,
          verdict: body.verdict,
          source: "user",
          reason: body.note ?? null,
        });
        // 教えた判定をすぐ反映する（AI は呼ばない）
        return NextResponse.json(await runReconciliation({ useAi: false, finalizeCash: false }));
      }
      case "rerun":
        return NextResponse.json(await runReconciliation({ useAi: false, finalizeCash: false }));
    }
  } catch (error) {
    console.error("[/api/reconcile] POST failed:", error);
    const message = error instanceof Error ? error.message : "操作に失敗しました";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
