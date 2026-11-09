import { lookupHisPatient, type HisLookup } from "./his";
import { sourceAfterUnlink, type NameSource } from "./patient-name";
import { supabaseAdmin } from "./supabase/admin";

/**
 * ผูกแชท (บัญชี LINE/FB) กับคนไข้ (HN) ได้ 2 ทาง: คนไข้ส่งรหัสจากใบนัด (link_code) หรือแอดมินยืนยันการจับคู่ (staff)
 * - HN เดียวผูกได้หลายบัญชี (คนไข้ + ญาติ) และบัญชีเดียวผูกได้หลาย HN (ญาติที่เป็นคนไข้ด้วย / ดูแลหลายคน)
 * - แถวผูก = (บัญชี, HN) ไม่ซ้ำ แต่ละแถวมีบทบาท patient | relative
 * - HN หลักของบัญชี (contacts.hn) = HN ที่เป็นคนไข้เอง (หลายอันใช้ที่ผูกล่าสุด แอดมินเปลี่ยนได้) ไม่มีใช้ HN ล่าสุดที่เป็นญาติ
 * - ชื่อแชท = "{ชื่อ HN หลัก} · HN {hn}" (ญาติล้วนต่อท้าย "(ญาติ)") ยกเว้นเจ้าหน้าที่ตั้งชื่อเองไว้ (name_locked) ห้ามเขียนทับ
 * ชื่อเอาจาก iService เสมอ ถ้าเรียกไม่ได้ใช้ชื่อในนัดที่มาจาก iService หรือชื่อที่เจ้าหน้าที่กรอก
 */
export type PatientRelation = "patient" | "relative";

/** HN ที่อาจเก็บไว้หลายรูป (4714 / 000004714) */
export function hnVariants(hn: string): string[] {
  const t = hn.trim();
  if (!/^\d+$/.test(t)) return [t];
  const bare = t.replace(/^0+/, "") || "0";
  return [...new Set([t, bare, bare.padStart(9, "0")])];
}

export const sameHn = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && hnVariants(a).includes(b.trim());

/** แชทที่ผูกกับ HN นี้ทั้งหมด เรียงตามเวลาผูก */
export async function linkedConversationsOf(hn: string | null | undefined): Promise<{ conversation_id: string; linked_at: string; role: PatientRelation }[]> {
  if (!hn?.trim()) return [];
  const { data } = await supabaseAdmin().from("patient_links").select("conversation_id, linked_at, role").in("hn", hnVariants(hn));
  return ((data ?? []) as { conversation_id: string; linked_at: string; role?: string | null }[])
    .map((r) => ({ ...r, role: (r.role === "relative" ? "relative" : "patient") as PatientRelation }))
    .sort((a, b) => a.linked_at.localeCompare(b.linked_at));
}

export interface ConversationLink { hn: string; role: PatientRelation; patient_name: string | null; phone: string | null; linked_at: string }

/** ทุก HN ที่ผูกกับแชทนี้ เรียงผูกล่าสุดก่อน */
export async function linksOfConversation(conversationId: string): Promise<ConversationLink[]> {
  const { data } = await supabaseAdmin().from("patient_links").select("hn, role, patient_name, phone, linked_at").eq("conversation_id", conversationId);
  // เวลาผูกเท่ากัน (ผูกติดกันเร็วมาก) ให้แถวที่เพิ่มทีหลังมาก่อน
  return ((data ?? []) as (ConversationLink & { role?: string | null })[])
    .map((r, i) => ({ ...r, role: (r.role === "relative" ? "relative" : "patient") as PatientRelation, i }))
    .sort((a, b) => b.linked_at.localeCompare(a.linked_at) || b.i - a.i)
    .map(({ i: _i, ...r }) => r);
}

/** บทบาทของแต่ละแชทต่อ HN นี้ */
export async function rolesForHn(hn: string | null | undefined, conversationIds: string[]): Promise<Map<string, PatientRelation>> {
  const out = new Map<string, PatientRelation>();
  if (!hn?.trim() || !conversationIds.length) return out;
  for (const l of await linkedConversationsOf(hn)) if (conversationIds.includes(l.conversation_id)) out.set(l.conversation_id, l.role);
  return out;
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

export interface LinkResult {
  hn: string; name: string | null; nameSource: NameSource | null; relation?: PatientRelation;
  /** บัญชีนี้ผูกกับ HN นี้อยู่แล้ว ไม่ได้สร้างแถวใหม่ */
  alreadyLinked?: boolean;
}

interface ContactRow { id: string; hn: string | null; name_locked: boolean | null; name_source: string | null; patient_relation?: string | null }

async function contactOf(conversationId: string): Promise<ContactRow | null> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("contact_id").eq("id", conversationId).maybeSingle();
  if (!conv) return null;
  const { data: c } = await db.from("contacts").select("id, hn, name_locked, name_source, patient_relation").eq("id", conv.contact_id as string).maybeSingle();
  return c as ContactRow | null;
}

async function logLink(row: { conversation_id: string; contact_id: string; hn: string; action: "link" | "unlink"; via: LinkVia; name_source: string | null; staff_id: string | null }) {
  const { error } = await supabaseAdmin().from("patient_link_events").insert(row);
  if (error) console.error("patient link log failed", error.code);
}

/**
 * ตั้ง HN หลักและชื่อแชทจากแถวผูกทั้งหมดของแชทนี้
 * เจ้าหน้าที่ตั้งชื่อแชทเองไว้ (name_locked) ไม่แตะชื่อ/แหล่งชื่อ แต่ยังเก็บ HN หลักไว้แสดง
 */
export async function refreshContactLabel(conversationId: string, opts: { preferHn?: string | null; nameSource?: NameSource | null } = {}): Promise<void> {
  const db = supabaseAdmin();
  const contact = await contactOf(conversationId);
  if (!contact) return;
  const links = await linksOfConversation(conversationId);
  if (!links.length) {
    await db.from("contacts").update({
      hn: null, patient_full_name: null, patient_relation: null,
      ...(contact.name_locked ? {} : { name_source: contact.name_source === "his" ? sourceAfterUnlink(contact) : contact.name_source ?? "platform" }),
    }).eq("id", contact.id);
    return;
  }
  const patients = links.filter((l) => l.role === "patient");
  const pick = (list: ConversationLink[]) =>
    list.find((l) => sameHn(l.hn, opts.preferHn ?? null)) ?? list.find((l) => sameHn(l.hn, contact.hn)) ?? list[0];
  // ญาติล้วน: ใช้ HN ล่าสุด (หรือที่แอดมินเลือก)
  const primary = patients.length ? pick(patients) : links.find((l) => sameHn(l.hn, opts.preferHn ?? null)) ?? links[0];
  const relation: PatientRelation = patients.length ? "patient" : "relative";
  await db.from("contacts").update({
    hn: primary.hn,
    patient_full_name: primary.patient_name,
    patient_relation: relation,
    ...(contact.name_locked || !primary.patient_name ? {} : { name_source: opts.nameSource ?? (contact.name_source === "his" ? "his" : contact.name_source === "staff" ? "staff" : "his") }),
  }).eq("id", contact.id);
}

export async function linkConversationToHn(conversationId: string, rawHn: string, opts: LinkOptions): Promise<LinkResult | null> {
  const db = supabaseAdmin();
  const hn = rawHn.trim();
  const contact = await contactOf(conversationId);
  if (!hn || !contact) return null;

  const mine = await linksOfConversation(conversationId);
  const existing = mine.find((l) => sameHn(l.hn, hn));
  // สแกนรหัสซ้ำจากบัญชีและ HN เดิม: ไม่สร้างแถวใหม่ ไม่แตะชื่อ
  if (existing) return { hn: existing.hn, name: existing.patient_name, nameSource: null, relation: existing.role, alreadyLinked: true };

  const his = opts.his ?? (await lookupHisPatient(hn));
  // บทบาทเริ่มต้น: บัญชีนี้เป็นคนไข้ของ HN อื่นอยู่แล้ว หรือ HN นี้มีบัญชีคนไข้อยู่แล้ว → ญาติ ไม่งั้นคนไข้
  const othersOfHn = (await linkedConversationsOf(hn)).filter((l) => l.conversation_id !== conversationId);
  const relation: PatientRelation = mine.some((l) => l.role === "patient") || othersOfHn.some((l) => l.role === "patient") ? "relative" : "patient";

  let name: string | null = null;
  let source: NameSource | null = null;
  if (his.status === "found") {
    name = his.name;
    source = "his";
  } else {
    // แชทอื่นของคนไข้คนนี้มีชื่อจาก HIS อยู่แล้ว ใช้ชื่อเดียวกัน
    const { data: same } = await db.from("patient_links").select("patient_name").in("hn", hnVariants(hn)).not("patient_name", "is", null).limit(1).maybeSingle();
    if (same?.patient_name) {
      name = same.patient_name as string;
      source = "his";
    } else if (opts.fallbackName?.trim()) {
      name = opts.fallbackName.trim();
      source = opts.fallbackFromHis ? "his" : "staff";
    }
  }

  const { error } = await db.from("patient_links").insert({
    conversation_id: conversationId, hn, role: relation, patient_name: name, phone: opts.phone ?? (his.status === "found" ? his.phone || null : null),
    source: opts.via, linked_by: opts.staffId, linked_at: new Date().toISOString(),
  });
  // ชนกัน = มีคนผูกพร้อมกันไปแล้ว ถือว่าผูกแล้ว
  if (error && error.code !== "23505") throw error;

  // บัญชีคนไข้ใหม่: HN นี้เป็น HN หลัก (ผูกล่าสุด) / ญาติ: HN หลักเดิมคงไว้
  await refreshContactLabel(conversationId, { preferHn: relation === "patient" ? hn : null, nameSource: source });
  // ชื่อจาก HIS ใช้กับแถวผูกอื่นของ HN นี้ (ไม่แตะชื่อแชทที่เจ้าหน้าที่ตั้งเอง)
  if (source === "his" && name) {
    await db.from("patient_links").update({ patient_name: name }).in("hn", hnVariants(hn));
    const { data: others } = await db.from("contacts").select("id, name_locked").in("hn", hnVariants(hn));
    const ids = ((others ?? []) as { id: string; name_locked: boolean | null }[]).filter((c) => c.id !== contact.id && !c.name_locked).map((c) => c.id);
    if (ids.length) await db.from("contacts").update({ patient_full_name: name }).in("id", ids);
  }
  await logLink({ conversation_id: conversationId, contact_id: contact.id, hn, action: "link", via: opts.via, name_source: source, staff_id: opts.staffId });
  await upsertPatient({ hn, full_name: name, phone: opts.phone ?? (his.status === "found" ? his.phone : null) });
  return { hn, name, nameSource: source, relation };
}

/** แอดมินแก้ป้าย คนไข้/ญาติ ของบัญชีต่อ HN นั้น (ไม่ระบุ HN = HN หลักของบัญชี) */
export async function setPatientRelation(conversationId: string, relation: PatientRelation, hn?: string | null): Promise<boolean> {
  const db = supabaseAdmin();
  const contact = await contactOf(conversationId);
  if (!contact) return false;
  const target = hn?.trim() || contact.hn;
  if (target) {
    const { data } = await db.from("patient_links").update({ role: relation }).eq("conversation_id", conversationId).in("hn", hnVariants(target)).select("hn");
    if (data?.length) {
      await refreshContactLabel(conversationId, relation === "patient" ? { preferHn: target } : {});
      return true;
    }
  }
  // นัดที่ไม่มี HN (บัญชีที่สแกนเพิ่ม): ป้ายเก็บที่ contacts
  const { error } = await db.from("contacts").update({ patient_relation: relation }).eq("id", contact.id);
  if (error) throw error;
  return true;
}

/** แอดมินเลือก HN หลักของบัญชี (ใช้ตั้งชื่อแชท) */
export async function setPrimaryHn(conversationId: string, hn: string): Promise<boolean> {
  const links = await linksOfConversation(conversationId);
  if (!links.some((l) => sameHn(l.hn, hn))) return false;
  await refreshContactLabel(conversationId, { preferHn: hn });
  return true;
}

/**
 * แอดมินยกเลิกการผูก: ระบุ HN = ยกเลิกเฉพาะแถว (บัญชี+HN) นั้น ไม่กระทบ HN อื่นของบัญชีเดียวกัน ไม่ระบุ = ทุก HN
 * นัดที่ยังไม่ถึงของ HN นั้นไม่ส่งเข้าแชทนี้แล้ว ถ้ายังมีบัญชีอื่นผูก HN นั้นอยู่ ย้ายแชทหลักของนัดไปบัญชีนั้น
 */
export async function unlinkConversation(conversationId: string, staffId: string, onlyHn?: string | null): Promise<{ hn: string } | null> {
  const db = supabaseAdmin();
  const contact = await contactOf(conversationId);
  if (!contact) return null;
  const links = await linksOfConversation(conversationId);
  const removing = onlyHn ? links.filter((l) => sameHn(l.hn, onlyHn)) : links;
  if (!removing.length) {
    // ข้อมูลเดิมที่มี hn ที่ contacts แต่ไม่มีแถวผูก
    if (!contact.hn || (onlyHn && !sameHn(contact.hn, onlyHn))) return null;
  }
  const hns = removing.length ? removing.map((l) => l.hn) : [contact.hn!];

  for (const hn of hns) {
    await db.from("patient_links").delete().eq("conversation_id", conversationId).in("hn", hnVariants(hn));
    const next = (await linkedConversationsOf(hn))[0]?.conversation_id ?? null;
    const { data: appts } = await db.from("appointments").select("id, status").eq("conversation_id", conversationId).in("hn", hnVariants(hn));
    const open = ((appts ?? []) as { id: string; status: string }[]).filter((a) => ["scheduled", "confirmed", "reschedule_requested"].includes(a.status));
    if (open.length) {
      await db.from("appointments").update({ conversation_id: next, updated_at: new Date().toISOString() }).in("id", open.map((a) => a.id));
      await db.from("appointment_events").insert(open.map((a) => ({ appointment_id: a.id, kind: "unlinked", actor: "staff", staff_id: staffId, detail: { conversation_id: conversationId, moved_to: next } })));
    }
    await logLink({ conversation_id: conversationId, contact_id: contact.id, hn, action: "unlink", via: "staff", name_source: null, staff_id: staffId });
  }
  if (!onlyHn) await db.from("appointment_recipients").delete().eq("conversation_id", conversationId);
  await refreshContactLabel(conversationId);
  return { hn: hns[0] };
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
export async function upsertPatient(p: { hn: string | null | undefined; full_name?: string | null; phone?: string | null }) {
  const hn = normalizeHn(p.hn);
  if (!hn) return;
  const phone = (p.phone ?? "").replace(/\D/g, "") || null;
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin().from("patients").upsert({
    hn, updated_at: now,
    ...(p.full_name?.trim() ? { full_name: p.full_name.trim() } : {}),
    ...(phone ? { phone, phone_fetched_at: now } : {}),
  }, { onConflict: "hn" });
  if (error) console.error("patients upsert failed", error.code);
}
