import { NextResponse } from "next/server";
import { denySensitiveChat, requireAdmin } from "@/lib/auth";
import { lookupHisPatient } from "@/lib/his";
import { linkConversationToHn, setPatientRelation, unlinkConversation } from "@/lib/patient-link-store";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const cleanHn = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 30) : "");

async function guard(id: string) {
  const r = await requireAdmin();
  if (r.error) return { error: r.error, user: null } as const;
  const denied = await denySensitiveChat(id, r.canViewSensitive);
  if (denied) return { error: denied, user: null } as const;
  return { error: null, user: r.user } as const;
}

/** ?hn= ดูชื่อจาก iService ก่อนยืนยันการจับคู่ */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { error } = await guard(id);
  if (error) return error;
  const hn = cleanHn(new URL(req.url).searchParams.get("hn"));
  if (!hn) return NextResponse.json({ error: "กรอก HN" }, { status: 400 });
  const his = await lookupHisPatient(hn);
  if (his.status === "error") return NextResponse.json({ error: "เชื่อมต่อ iService ไม่สำเร็จ" }, { status: 502 });
  if (his.status === "not_found") return NextResponse.json({ error: "ไม่พบ HN นี้ใน iService" }, { status: 404 });
  return NextResponse.json({ hn: his.hn, name: his.name });
}

/** แอดมินยืนยันการจับคู่ { hn } ชื่อเอาจาก iService เท่านั้น */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { error, user } = await guard(id);
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { hn?: unknown };
  const hn = cleanHn(b.hn);
  if (!hn) return NextResponse.json({ error: "กรอก HN" }, { status: 400 });
  const his = await lookupHisPatient(hn);
  if (his.status === "error") return NextResponse.json({ error: "เชื่อมต่อ iService ไม่สำเร็จ" }, { status: 502 });
  if (his.status === "not_found") return NextResponse.json({ error: "ไม่พบ HN นี้ใน iService" }, { status: 404 });
  const result = await linkConversationToHn(id, his.hn, { via: "staff", staffId: user.id, his });
  if (!result) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });
  return NextResponse.json(result);
}

/** แอดมินแก้ป้ายบัญชี { relation: "patient" | "relative" } */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const { error } = await guard(id);
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { relation?: unknown };
  if (b.relation !== "patient" && b.relation !== "relative") return NextResponse.json({ error: "ป้ายไม่ถูกต้อง" }, { status: 400 });
  if (!(await setPatientRelation(id, b.relation))) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** แอดมินยกเลิกการผูก: กลับไปใช้ชื่อเดิม บันทึกว่าใครทำ */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const { error, user } = await guard(id);
  if (error) return error;
  const result = await unlinkConversation(id, user.id);
  if (!result) return NextResponse.json({ error: "แชทนี้ยังไม่ได้ผูก HN" }, { status: 404 });
  return NextResponse.json({ ok: true, ...result });
}
