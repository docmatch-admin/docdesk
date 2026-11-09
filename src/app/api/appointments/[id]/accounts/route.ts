import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { detachAccount } from "@/lib/appointment-store";
import { setPatientRelation } from "@/lib/patient-link-store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** แอดมินแก้ป้ายบัญชี { conversation_id, relation: "patient" | "relative" } */
export async function PATCH(req: Request, _ctx: Ctx) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { conversation_id?: unknown; relation?: unknown };
  if (typeof b.conversation_id !== "string" || !UUID.test(b.conversation_id)) return NextResponse.json({ error: "ไม่พบบัญชี" }, { status: 400 });
  if (b.relation !== "patient" && b.relation !== "relative") return NextResponse.json({ error: "ป้ายไม่ถูกต้อง" }, { status: 400 });
  if (!(await setPatientRelation(b.conversation_id, b.relation))) return NextResponse.json({ error: "ไม่พบบัญชี" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** แอดมินยกเลิกการผูกบัญชีหนึ่ง ?conversation_id= */
export async function DELETE(req: Request, { params }: Ctx) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const { id } = await params;
  const cid = new URL(req.url).searchParams.get("conversation_id") ?? "";
  if (!UUID.test(cid)) return NextResponse.json({ error: "ไม่พบบัญชี" }, { status: 400 });
  if (!(await detachAccount(id, cid, user.id))) return NextResponse.json({ error: "ไม่พบนัด" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
