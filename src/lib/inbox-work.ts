// งานค้างของแต่ละแชท (ช่วง "งานค้าง" ในรายการแชท) — คำนวณฝั่ง server ด้วย service role
import { bangkokToday, OPEN_STATUSES } from "./appointment-rules";
import type { WorkItem, WorkKind, WorkMap } from "./case-flow";
import { hnVariants } from "./patient-link-store";
import { supabaseAdmin } from "./supabase/admin";

const MAX_ROWS = 1000;

/**
 * - ยืนยันนัด: นัดที่ AI รับไว้/คนไข้ขอ (bookings ai_confirmed) ที่ยังไม่ลงนัด
 * - ขอเลื่อนนัด: นัดที่คนไข้กดขอเลื่อน (ยังไม่ได้โทร)
 * - ส่งไม่สำเร็จ: ข้อความนัดส่งไม่ถึง (last_send_error) · ผลแล็บส่ง LINE ไม่สำเร็จ
 * - งานทีม N: งานของทีมในแชทที่ยังไม่เสร็จ
 * - AI ตอบแล้ว รอตรวจ: AI ตอบเองแล้วยังไม่มีเจ้าหน้าที่เปิดดู (ai_review_at, migration 062)
 */
export async function inboxWork(now = Date.now()): Promise<WorkMap> {
  const db = supabaseAdmin();
  const today = bangkokToday(now);
  const out: WorkMap = {};
  const add = (conversationId: string | null | undefined, kind: WorkKind, since: string | null | undefined, count?: number) => {
    if (!conversationId) return;
    const list = (out[conversationId] ??= []);
    const cur = list.find((i) => i.kind === kind);
    const at = since ?? new Date(now).toISOString();
    if (!cur) list.push({ kind, since: at, ...(count ? { count } : {}) });
    else {
      if (at < cur.since) cur.since = at;
      if (count) cur.count = (cur.count ?? 0) + count;
    }
  };

  const [bookings, appts, labs, tasks, ai] = await Promise.all([
    db.from("bookings").select("conversation_id, created_at").eq("status", "ai_confirmed").limit(MAX_ROWS),
    db.from("appointments").select("hn, conversation_id, status, last_send_error, called_at, updated_at")
      .gte("appoint_date", today).in("status", OPEN_STATUSES).is("called_at", null).limit(MAX_ROWS),
    db.from("lab_results").select("patient_id, updated_at").eq("notify_status", "failed").limit(MAX_ROWS),
    db.from("chat_tasks").select("conversation_id, created_at").eq("done", false).limit(MAX_ROWS),
    // ยังไม่ได้รัน migration 062 = ไม่มีคอลัมน์ → ข้ามงานนี้ ไม่ล้มทั้งรายการ
    db.from("conversations").select("id, ai_review_at").not("ai_review_at", "is", null).limit(MAX_ROWS),
  ]);

  for (const b of (bookings.data ?? []) as { conversation_id: string; created_at: string }[]) add(b.conversation_id, "booking", b.created_at);
  for (const t of (tasks.data ?? []) as { conversation_id: string; created_at: string }[]) add(t.conversation_id, "tasks", t.created_at, 1);
  if (!ai.error) for (const c of (ai.data ?? []) as { id: string; ai_review_at: string }[]) add(c.id, "ai_review", c.ai_review_at);

  // นัด/ผลแล็บผูกกับแชทผ่าน conversation_id ของนัด และทุกบัญชีที่ผูก HN
  type Appt = { hn: string | null; conversation_id: string | null; status: string; last_send_error: string | null; updated_at: string };
  const apptRows = ((appts.data ?? []) as Appt[]).filter((a) => a.status === "reschedule_requested" || a.last_send_error);
  const labRows = (labs.data ?? []) as { patient_id: string | null; updated_at: string }[];
  const hns = [...new Set([...apptRows.map((a) => a.hn), ...labRows.map((l) => l.patient_id)].filter((h): h is string => !!h?.trim()))];
  const byHn = new Map<string, string[]>();
  if (hns.length) {
    const { data: links } = await db.from("patient_links").select("conversation_id, hn").in("hn", hns.flatMap(hnVariants));
    const bare = (h: string) => h.trim().replace(/^0+/, "");
    for (const l of (links ?? []) as { conversation_id: string; hn: string }[]) {
      const k = bare(l.hn);
      byHn.set(k, [...(byHn.get(k) ?? []), l.conversation_id]);
    }
  }
  const convsOf = (hn: string | null, direct?: string | null) =>
    [...new Set([...(direct ? [direct] : []), ...(hn ? byHn.get(hn.trim().replace(/^0+/, "")) ?? [] : [])])];
  for (const a of apptRows) {
    const kind: WorkKind = a.status === "reschedule_requested" ? "reschedule" : "failed";
    for (const c of convsOf(a.hn, a.conversation_id)) add(c, kind, a.updated_at);
  }
  for (const l of labRows) for (const c of convsOf(l.patient_id)) add(c, "failed", l.updated_at);
  return out;
}

/** badge เมนู "แชท": รอตอบ + งานค้าง (แชทเดียวนับครั้งเดียว) */
export async function inboxCounts(now = Date.now()): Promise<{ waiting: number; work: number; total: number }> {
  const db = supabaseAdmin();
  const work = await inboxWork(now);
  const { data } = await db.from("conversations").select("id").eq("status", "open").eq("last_direction", "in").eq("archived", false).limit(5000);
  const waiting = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
  const workIds = Object.keys(work).filter((id) => !waiting.has(id));
  return { waiting: waiting.size, work: workIds.length, total: waiting.size + workIds.length };
}

export type { WorkItem };
