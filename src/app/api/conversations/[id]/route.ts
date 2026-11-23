import { NextResponse } from "next/server";
import { findArchiveCandidates } from "@/lib/archive-store";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { conversationAppointments } from "@/lib/conversation-appointments";
import { listLabResults } from "@/lib/lab-results-store";
import { serverTiming } from "@/lib/server-timing";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * เปิดแชท 1 แชท = ข้อมูลทั้งห้องใน request เดียว (แทนการยิงแยก ~15 ครั้ง)
 * ข้อความ · นัดรอลง · คำแนะนำล่าสุด · ประวัติผู้ดูแล · งาน/คอมเมนต์ทีม · ใครติดแท็ก · แชทเก่าที่รวมได้ · กล่องนัด · ผลแล็บ
 * แชทลับไม่ส่งข้อความมาที่นี่ (ต้องเปิดผ่าน /messages ซึ่งตรวจการรับทราบและบันทึกประวัติการเปิด)
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = serverTiming();
  const { canViewSensitive, error } = await t.time("auth", requireStaff());
  if (error) return error;
  const { id } = await params;
  const denied = await t.time("sensitive", denySensitiveChat(id, canViewSensitive));
  if (denied) return denied;
  const db = supabaseAdmin();
  const { data: conv } = await t.time("conv", async () => await db.from("conversations").select("sensitive, archived").eq("id", id).maybeSingle());
  if (!conv) return NextResponse.json({ error: "ไม่พบแชท" }, { status: 404 });

  const part = <T,>(label: string, p: PromiseLike<T> | (() => Promise<T>), fallback: T) =>
    t.time(label, async () => { try { return await (typeof p === "function" ? p() : p); } catch { return fallback; } });
  const rows = <R,>(r: { data: R[] | null }) => r.data ?? [];

  const [messages, bookings, suggestion, history, tasks, notes, tagEvents, archive, appointments, labResults] = await Promise.all([
    conv.sensitive ? Promise.resolve(null)
      : part("messages", async () => rows(await db.from("messages").select("*").eq("conversation_id", id).order("created_at", { ascending: false }).limit(300)).reverse(), null),
    part("bookings", async () => rows(await db.from("bookings").select('id, service, "date", "time", name, phone, status')
      .eq("conversation_id", id).neq("status", "cancelled").order("date").order("time")), null),
    part("suggestion", async () => (await db.from("suggestions").select("id, options, needs_human, suggested_tags")
      .eq("conversation_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle()).data ?? null, undefined),
    part("history", async () => rows(await db.from("assignment_log").select("id, from_staff, to_staff, by_staff, created_at")
      .eq("conversation_id", id).order("created_at", { ascending: false }).limit(20)), null),
    part("tasks", async () => rows(await db.from("chat_tasks").select("*").eq("conversation_id", id).order("created_at")), null),
    part("notes", async () => rows(await db.from("chat_notes").select("*").eq("conversation_id", id).order("created_at")), null),
    part("tags", async () => rows(await db.from("tag_events").select("tag, action, by, created_at").eq("conversation_id", id).eq("action", "add").order("created_at")), null),
    part("archive", () => findArchiveCandidates(id, canViewSensitive), null),
    part("appointments", () => conversationAppointments(id), null),
    part("labs", async () => (await listLabResults({ conversationId: id })).rows, null),
  ]);
  let tagSources: Record<string, string> | null = null;
  if (tagEvents) {
    tagSources = {};
    for (const e of tagEvents as { tag: string; by: string }[]) tagSources[e.tag] = e.by;
  }
  // null = ส่วนนั้นโหลดไม่สำเร็จ → หน้าเว็บโหลดเองตามเดิม
  return NextResponse.json({
    conv, messages, bookings, suggestion, history, tasks, notes, tagSources, archive, appointments, labResults,
  }, { headers: t.headers() });
}
