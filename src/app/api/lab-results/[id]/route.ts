import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { labErrorResponse } from "@/lib/lab-http";
import { matchLabResult, notifyLabResult } from "@/lib/lab-results-store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** { action: "match", hn } จับคู่คนไข้เอง (hn ว่าง = ยกเลิก) · { action: "resend" } ส่งแจ้งซ้ำ */
export async function PATCH(req: Request, { params }: Ctx) {
  const { user, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; hn?: unknown };
  try {
    if (b.action === "match") return NextResponse.json(await matchLabResult(id, typeof b.hn === "string" ? b.hn : null, user.id));
    if (b.action === "resend") return NextResponse.json({ notify: await notifyLabResult(id) });
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  } catch (e) {
    return labErrorResponse(e, "lab-results:patch");
  }
}
