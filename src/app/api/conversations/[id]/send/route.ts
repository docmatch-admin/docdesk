import { NextResponse } from "next/server";
import { LineQuotaError } from "@/lib/channels/line-log";
import { denyArchivedChat, denySensitiveChat, requireStaff } from "@/lib/auth";
import { isStillBookable } from "@/lib/booking-rules";
import { cancelBooking, loadBusinessHours } from "@/lib/booking-store";
import { sendReply } from "@/lib/pipeline";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { SuggestionOption } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const archived = await denyArchivedChat(id);
  if (archived) return archived;
  const body = (await req.json().catch(() => ({}))) as {
    text?: string; suggestionId?: string | null; chosenIndex?: number | null; skipTranslate?: boolean; cancelBookingId?: string | null;
  };
  if (!body.text?.trim()) return NextResponse.json({ error: "ข้อความว่าง" }, { status: 400 });

  // คำแนะนำอาจค้างไว้นาน เวลานัดในนั้นอาจผ่านไปแล้วตอนกดส่ง
  if (body.suggestionId && body.chosenIndex != null) {
    const { data } = await supabaseAdmin().from("suggestions").select("options").eq("id", body.suggestionId).maybeSingle();
    const booking = ((data?.options ?? []) as SuggestionOption[])[body.chosenIndex]?.booking;
    if (booking?.action === "confirm" && !isStillBookable(booking.date as string, booking.time as string, await loadBusinessHours(), Date.now())) {
      return NextResponse.json({ error: "เวลานัดนี้ใช้ไม่ได้แล้ว กด แนะนำใหม่" }, { status: 409 });
    }
  }

  try {
    const res = await sendReply({
      conversationId: id,
      textTh: body.text.trim(),
      senderType: "staff",
      senderId: user.id,
      suggestionId: body.suggestionId ?? null,
      chosenIndex: body.chosenIndex ?? null,
      skipTranslate: !!body.skipTranslate,
      skipLearn: !!body.cancelBookingId,
    });
    // ลูกค้าได้ข้อความขอเลื่อนแล้วจึงยกเลิกนัด
    if (body.cancelBookingId) await cancelBooking(body.cancelBookingId, id);
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof LineQuotaError) return NextResponse.json({ error: "ส่งไม่ได้: โควตา LINE เดือนนี้หมด", code: "line_quota" }, { status: 429 });
    console.error(e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "ส่งไม่สำเร็จ" }, { status: 500 });
  }
}
