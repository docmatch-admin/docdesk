import { lookupHisPatient, type HisLookup } from "./his";
import { sourceAfterUnlink, type NameSource } from "./patient-name";
import { supabaseAdmin } from "./supabase/admin";

/**
 * ผูกแชทกับคนไข้ (HN) ได้ 2 ทาง: คนไข้ส่งรหัสจากใบนัด (link_code) หรือแอดมินยืนยันการจับคู่ (staff)
 * ชื่อที่แสดงเอาจาก iService เสมอ ถ้าเรียกไม่ได้ใช้ชื่อในนัดที่มาจาก iService หรือชื่อที่เจ้าหน้าที่กรอก
 * คนไข้คนเดียวหลายแชท (LINE/Facebook/Instagram) ทุกแชทแสดงชื่อเดียวกัน
 */
export type LinkVia = "link_code" | "staff";

export interface LinkOptions {
  via: LinkVia;
  staffId: string | null;
  /** ชื่อสำรองเมื่อ iService ไม่ตอบ */
  fallbackName?: string | null;
  /** ชื่อสำรองมาจาก iService เอง (เลือกจาก visit หรือค้นหา) */
  fallbackFromHis?: boolean;
  phone?: string | null;
  /** ผลค้น iService ที่ได้มาแล้ว ไม่ต้องเรียกซ้ำ */
  his?: HisLookup;
}

export interface LinkResult { hn: string; name: string | null; nameSource: NameSource | null }

async function contactOf(conversationId: string) {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("contact_id").eq("id", conversationId).maybeSingle();
  if (!conv) return null;
  const { data: c } = await db.from("contacts").select("id, hn, name_locked, name_source").eq("id", conv.contact_id as string).maybeSingle();
  return c as { id: string; hn: string | null; name_locked: boolean | null; name_source: string | null } | null;
}

async function logLink(row: { conversation_id: string; contact_id: string; hn: string; action: "link" | "unlink"; via: LinkVia; name_source: string | null; staff_id: string | null }) {
  const { error } = await supabaseAdmin().from("patient_link_events").insert(row);
  if (error) console.error("patient link log failed", error.code);
}

export async function linkConversationToHn(conversationId: string, rawHn: string, opts: LinkOptions): Promise<LinkResult | null> {
  const db = supabaseAdmin();
  const hn = rawHn.trim();
  const contact = await contactOf(conversationId);
  if (!hn || !contact) return null;

  const his = opts.his ?? (await lookupHisPatient(hn));
  let name: string | null = null;
  let source: NameSource | null = null;
  if (his.status === "found") {
    name = his.name;
    source = "his";
  } else {
    // แชทอื่นของคนไข้คนนี้มีชื่อจาก HIS อยู่แล้ว ใช้ชื่อเดียวกัน
    const { data: same } = await db.from("contacts").select("patient_full_name, name_source").eq("hn", hn).eq("name_source", "his").limit(1).maybeSingle();
    if (same?.patient_full_name) {
      name = same.patient_full_name as string;
      source = "his";
    } else if (opts.fallbackName?.trim()) {
      name = opts.fallbackName.trim();
      source = opts.fallbackFromHis ? "his" : "staff";
    }
  }

  const { error } = await db.from("patient_links").upsert({
    conversation_id: conversationId, hn, patient_name: name, phone: opts.phone ?? (his.status === "found" ? his.phone || null : null),
    source: opts.via, linked_by: opts.staffId, linked_at: new Date().toISOString(),
  }, { onConflict: "conversation_id" });
  if (error) throw error;

  await db.from("contacts").update({
    hn,
    patient_full_name: name,
    // ไม่มีชื่อเลย: แสดงชื่อเดิมพร้อม HN และคงแหล่งชื่อเดิม
    ...(source ? { name_source: source } : {}),
  }).eq("id", contact.id);
  // ชื่อจาก HIS ใช้กับทุกแชทของ HN นี้
  if (source === "his" && name) {
    await db.from("contacts").update({ patient_full_name: name, name_source: "his" }).eq("hn", hn);
  }
  await logLink({ conversation_id: conversationId, contact_id: contact.id, hn, action: "link", via: opts.via, name_source: source, staff_id: opts.staffId });
  return { hn, name, nameSource: source };
}

/** แอดมินยกเลิกการผูก: กลับไปใช้ชื่อเดิม และไม่ส่งข้อความนัดของ HN นี้เข้าแชทนี้อีก */
export async function unlinkConversation(conversationId: string, staffId: string): Promise<{ hn: string } | null> {
  const db = supabaseAdmin();
  const contact = await contactOf(conversationId);
  const { data: link } = await db.from("patient_links").select("hn").eq("conversation_id", conversationId).maybeSingle();
  const hn = (link?.hn as string | undefined) ?? contact?.hn ?? null;
  if (!contact || !hn) return null;

  await db.from("patient_links").delete().eq("conversation_id", conversationId);
  await db.from("contacts").update({
    hn: null, patient_full_name: null,
    name_source: contact.name_source === "his" ? sourceAfterUnlink(contact) : contact.name_source ?? "platform",
  }).eq("id", contact.id);

  // นัดที่ยังไม่ถึงของ HN นี้ไม่ส่งเข้าแชทนี้แล้ว ให้ทีมโทรแทนหรือให้คนไข้สแกน QR ใหม่
  const { data: appts } = await db.from("appointments").select("id, status").eq("conversation_id", conversationId).eq("hn", hn);
  const open = ((appts ?? []) as { id: string; status: string }[]).filter((a) => ["scheduled", "confirmed", "reschedule_requested"].includes(a.status));
  if (open.length) {
    await db.from("appointments").update({ conversation_id: null, updated_at: new Date().toISOString() }).in("id", open.map((a) => a.id));
    await db.from("appointment_events").insert(open.map((a) => ({ appointment_id: a.id, kind: "unlinked", actor: "staff", staff_id: staffId, detail: { conversation_id: conversationId } })));
  }
  await logLink({ conversation_id: conversationId, contact_id: contact.id, hn, action: "unlink", via: "staff", name_source: null, staff_id: staffId });
  return { hn };
}
