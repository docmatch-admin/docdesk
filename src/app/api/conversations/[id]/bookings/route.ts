import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { parseBookingDate, parseBookingTime } from "@/lib/booking-rules";
import { setConversationTag } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * เจ้าหน้าที่ทำนัดเองจากแชท: { service, date, time, name?, phone? }
 * เจ้าหน้าที่ลงระบบเองแล้ว จึงเป็น recorded ทันที ไม่ทำให้แชทติด "ลงนัดก่อน"
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("id").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const service = clip(b.service, 200);
  if (!service) return NextResponse.json({ error: "ต้องมีชื่อบริการ" }, { status: 400 });
  const date = parseBookingDate(b.date);
  if (!date) return NextResponse.json({ error: "วันที่ไม่ถูกต้อง" }, { status: 400 });
  const time = parseBookingTime(b.time);
  if (!time) return NextResponse.json({ error: "เวลาไม่ถูกต้อง" }, { status: 400 });

  const now = new Date().toISOString();
  const { data, error: dbError } = await db.from("bookings").insert({
    conversation_id: id, service, date, time,
    name: clip(b.name, 100) || null,
    phone: clip(b.phone, 30) || null,
    status: "recorded", recorded_at: now, recorded_by: user.id, updated_at: now,
  }).select('id, service, "date", "time", name, phone, status').single();
  if (dbError || !data) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  await setConversationTag(id, "นัดแล้ว", "add", "staff").catch((e) => console.error("booking tag failed", e));
  return NextResponse.json({ booking: data });
}
