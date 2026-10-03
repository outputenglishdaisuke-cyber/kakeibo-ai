import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OperationError } from "@/lib/manual-reconcile";
import { executeOperation, type OperationRequest } from "@/lib/manual-reconcile-service";

/** 1回のリクエストで処理する操作の上限（一括操作は画面側で小分けにして送る） */
const MAX_OPERATIONS = 10;

const id = z.string().min(1);
const expected = z.record(z.string(), z.string());

const operationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("link"),
    cardIds: z.array(id).min(1).max(20),
    receiptIds: z.array(id).min(1).max(20),
    diffMode: z.enum(["tax", "other"]).nullable().optional(),
    expected,
  }),
  z.object({ kind: z.literal("cash"), receiptId: id, expected }),
  z.object({
    kind: z.literal("duplicate"),
    receiptId: id,
    partnerId: id,
    note: z.string().trim().max(200).nullable().optional(),
    expected,
  }),
  z.object({ kind: z.literal("unknown"), id, expected }),
  z.object({
    kind: z.literal("card_only"),
    cardId: id,
    parts: z
      .array(z.object({ categoryId: id, amount: z.number().int() }))
      .min(1)
      .max(10),
    createRule: z.boolean().optional(),
    expected,
  }),
  z.object({ kind: z.literal("unlink"), cardId: id, expected: expected.optional() }),
  z.object({ kind: z.literal("undo"), opId: id }),
]);

const bodySchema = z.object({
  operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS),
});

/**
 * 照合画面の手動操作。操作ごとに別のトランザクションで実行し、結果を操作ごとに返す。
 * 状態が変わっていた操作は code=conflict（画面の再読み込みが必要）で失敗する。
 */
export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "操作の指定が不正です", detail: parsed.error.flatten() }, { status: 400 });
  }
  const results = [];
  for (const op of parsed.data.operations as OperationRequest[]) {
    try {
      results.push({ ok: true as const, ...(await executeOperation(op)) });
    } catch (error) {
      if (error instanceof OperationError) {
        results.push({ ok: false as const, code: error.code, error: error.message });
      } else {
        console.error("[/api/reconcile/operations] failed:", error);
        results.push({
          ok: false as const,
          code: "error" as const,
          error: "操作に失敗しました（変更は保存されていません）",
        });
      }
    }
  }
  const status = results.every((r) => r.ok)
    ? 200
    : results.length === 1 && !results[0].ok
      ? results[0].code === "conflict"
        ? 409
        : results[0].code === "invalid"
          ? 400
          : 500
      : 207;
  return NextResponse.json({ results }, { status });
}
