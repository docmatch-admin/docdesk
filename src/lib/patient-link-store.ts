import { lookupHisPatient, type HisLookup } from "./his";
import { sourceAfterUnlink, type NameSource } from "./patient-name";
import { supabaseAdmin } from "./supabase/admin";

/**
 * ผูกแชทกับคนไข้ (HN) ได้ 2 ทาง: คนไข้ส่งรหัสจากใบนัด (link_code) หรือแอดมินยืนยันการจับคู่ (staff)
 * ชื่อที่แสดงเอาจาก iService เสมอ ถ้าเรียกไม่ได้ใช้ชื่อในนัดที่มาจาก iService หรือชื่อที่เจ้าหน้าที่กรอก
 * คนไข้คนเดียวหลายแชท (LINE/Facebook/Instagram) ทุกแชทแสดงชื่อเดียวกัน
 * HN เดียวผูกได้หลายบัญชี (คนไข้ + ญาติผู้ดูแล) บัญชีใหม่เพิ่มเข้าไป ไม่แทนบัญชีเดิม
 * บัญชีแรกของ HN = คนไข้ บัญชีถัดไป = ญาติ (แอดมินแก้ป้ายได้)
 */
export type PatientRelation = "patient" | "relative";

/** HN ที่อาจเก็บไว้หลายรูป (4714 / 000004714) */
export function hnVariants(hn: string): string[] {
  const t = hn.trim();
  if (!/^d+$/.test(t)) return [t];
  const bare = t.replace(/^0+/, "") || "0";
  return [...new Set([t, bare, bare.padStart(9, "0")])];
}

/** แชทที่ผูกกับ HN นี้ทั้งหมด เรียงตามเวลาผูก */
export async function linkedConversationsOf(hn: string | null | undefined): Promise<{ conversation_id: string; linked_at: string }[]> {
  if (!hn?.trim()) return [];
  const { data } = await supabaseAdmin().from("patient_links").select("conversation_id, linked_at").in("hn", hnVariants(hn));
  return ((data ?? []) as { conversation_id: string; linked_at: string }[]).sort((a, b) => a.linked_at.localeCompare(b.linked_at));
}
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

export interface LinkResult { hn: string; name: string | null; nameSource: NameSource | null; relation?: PatientRelation }

async function contactOf(conversationId: string) {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("contact_id").eq("id", conversationId).maybeSingle();
  if (!conv) return null;
  const { data: c } = await db.from("contacts").select("id, hn, name_locked, name_source, patient_relation").eq("id", conv.contact_id as string).maybeSingle();
  return c as { id: string; hn: string | null; name_locked: boolean | null; name_source: string | null; patient_relation?: string | null } | null;
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
  // บัญชีอื่นผูก HN นี้อยู่แล้ว = บัญชีนี้เป็นญาติ (ผูกซ้ำบัญชีเดิมคงป้ายเดิม)
  const others = (await linkedConversationsOf(hn)).filter((l) => l.conversation_id !== conversationId);
  const sameHnBefore = !!contact.hn && hnVariants(hn).includes(contact.hn.trim());
  const relation: PatientRelation = sameHnBefore && contact.patient_relation === "relative" ? "relative"
    : sameHnBefore && contact.patient_relation === "patient" ? "patient"
    : others.length ? "relative" : "patient";
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
    patient_relation: relation,
    // ไม่มีชื่อเลย: แสดงชื่อเดิมพร้อม HN และคงแหล่งชื่อเดิม
    ...(source ? { name_source: source } : {}),
  }).eq("id", contact.id);
  // ชื่อจาก HIS ใช้กับทุกแชทของ HN นี้
  if (source === "his" && name) {
    await db.from("contacts").update({ patient_full_name: name, name_source: "his" }).eq("hn", hn);
  }
  await logLink({ conversation_id: conversationId, contact_id: contact.id, hn, action: "link", via: opts.via, name_source: source, staff_id: opts.staffId });
  await upsertPatient({ hn, full_name: name, phone: opts.phone ?? (his.status === "found" ? his.phone : null) });
  return { hn, name, nameSource: source, relation };
}

/** แอดมินแก้ป้าย คนไข้/ญาติ ของบัญชี (ชื่อแชทต่อท้าย "(ญาติ)" เมื่อผูก HN) */
export async function setPatientRelation(conversationId: string, relation: PatientRelation): Promise<boolean> {
  const contact = await contactOf(conversationId);
  if (!contact) return false;
  const { error } = await supabaseAdmin().from("contacts").update({ patient_relation: relation }).eq("id", contact.id);
  if (error) throw error;
  return true;
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
    hn: null, patient_full_name: null, patient_relation: null,
    name_source: contact.name_source === "his" ? sourceAfterUnlink(contact) : contact.name_source ?? "platform",
  }).eq("id", contact.id);

  // นัดที่ยังไม่ถึงของ HN นี้ไม่ส่งเข้าแชทนี้แล้ว ถ้ายังมีบัญชีอื่นที่ผูก HN นี้ ย้ายไปเป็นแชทหลักของนัดแทน
  // ไม่เหลือบัญชีเลย ให้ทีมโทรแทนหรือให้คนไข้สแกน QR ใหม่
  const next = (await linkedConversationsOf(hn))[0]?.conversation_id ?? null;
  const { data: appts } = await db.from("appointments").select("id, status").eq("conversation_id", conversationId).in("hn", hnVariants(hn));
  const open = ((appts ?? []) as { id: string; status: string }[]).filter((a) => ["scheduled", "confirmed", "reschedule_requested"].includes(a.status));
  if (open.length) {
    await db.from("appointments").update({ conversation_id: next, updated_at: new Date().toISOString() }).in("id", open.map((a) => a.id));
    await db.from("appointment_events").insert(open.map((a) => ({ appointment_id: a.id, kind: "unlinked", actor: "staff", staff_id: staffId, detail: { conversation_id: conversationId, moved_to: next } })));
  }
  await db.from("appointment_recipients").delete().eq("conversation_id", conversationId);
  await logLink({ conversation_id: conversationId, contact_id: contact.id, hn, action: "unlink", via: "staff", name_source: null, staff_id: staffId });
  return { hn };
}

/** HN ของ iService: ตัวเลขเติม 0 ให้ครบ 9 หลัก ไม่ใช่ตัวเลข (เช่น HN ทดสอบ) คืน null */
export const normalizeHn = (hn: string | null | undefined) => {
  const t = (hn ?? "").trim();
  return /^\d{1,9}$/.test(t) ? t.padStart(9, "0") : null;
};

/**
 * ตาราง patients ของ DocDesk: บันทึกเมื่อลงนัดหรือผูกแชทกับ HN เท่านั้น (ไม่ sync ทะเบียนทั้งหมด)
 * ใช้ค้นด้วยชื่อ และเป็นเบอร์สำรองตอน iService ล่ม ไม่เก็บเลขบัตรประชาชน
 */
export async function upsertPatient(p: { hn: string | null | undefined; full_name?: string | null; phone?: string | null; slip_lang?: "th" | "en" }) {
  const hn = normalizeHn(p.hn);
  if (!hn) return;
  const phone = (p.phone ?? "").replace(/\D/g, "") || null;
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin().from("patients").upsert({
    hn, updated_at: now,
    ...(p.full_name?.trim() ? { full_name: p.full_name.trim() } : {}),
    ...(phone ? { phone, phone_fetched_at: now } : {}),
    ...(p.slip_lang ? { slip_lang: p.slip_lang } : {}),
  }, { onConflict: "hn" });
  if (error) console.error("patients upsert failed", error.code);
}
