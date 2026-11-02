import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { parseBookingDate, parseBookingTime } from "@/lib/booking-rules";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** แก้รายละเอียดนัดจากการ์ดในแชท */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const { data: owner } = await supabaseAdmin().from("bookings").select("conversation_id").eq("id", id).maybeSingle();
  if (owner) {
    const denied = await denySensitiveChat(owner.conversation_id as string, canViewSensitive);
    if (denied) return denied;
  }
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.service !== undefined) {
    if (!clip(b.service, 200)) return NextResponse.json({ error: "ต้องมีชื่อบริการ" }, { status: 400 });
    patch.service = clip(b.service, 200);
  }
  if (b.date !== undefined) {
    const date = parseBookingDate(b.date);
    if (!date) return NextResponse.json({ error: "วันที่ไม่ถูกต้อง" }, { status: 400 });
    patch.date = date;
  }
  if (b.time !== undefined) {
    const time = parseBookingTime(b.time);
    if (!time) return NextResponse.json({ error: "เวลาไม่ถูกต้อง" }, { status: 400 });
    patch.time = time;
  }
  if (b.name !== undefined) patch.name = clip(b.name, 200) || null;
  if (b.phone !== undefined) patch.phone = clip(b.phone, 30) || null;

  const { data, error: dbError } = await supabaseAdmin().from("bookings").update(patch).eq("id", id).select("id");
  if (dbError) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "ไม่พบนัด" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
