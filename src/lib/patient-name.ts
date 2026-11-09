/**
 * ชื่อลูกค้าใน DocDesk มี 3 แหล่งเท่านั้น ลำดับความสำคัญ his > staff > platform
 *   his      = ชื่อจาก iService เมื่อผูก HN (ล็อก แก้ได้หลังยกเลิกการผูกเท่านั้น)
 *   staff    = เจ้าหน้าที่แก้ชื่อเองที่หัวแชท
 *   platform = ชื่อบัญชี LINE/Facebook/Instagram
 * AI ไม่ตั้งหรือแก้ชื่อลูกค้า (เรียกชื่อในคำตอบได้ตามบริบทแชทเท่านั้น)
 * ใช้ได้ทั้ง server และหน้าเว็บ
 */
export type NameSource = "his" | "staff" | "platform";

const RANK: Record<NameSource, number> = { platform: 0, staff: 1, his: 2 };
const sourceOf = (s: unknown): NameSource => (s === "his" || s === "staff" ? s : "platform");

/** ชื่อจากแหล่ง incoming เขียนทับชื่อปัจจุบันได้ไหม */
export const canOverwriteName = (current: unknown, incoming: NameSource) => RANK[incoming] >= RANK[sourceOf(current)];

export interface ContactNameFields {
  display_name?: string | null;
  platform_name?: string | null;
  patient_full_name?: string | null;
  hn?: string | null;
  name_source?: string | null;
  name_locked?: boolean | null;
  /** HN เดียวหลายบัญชี: relative = บัญชีญาติผู้ดูแล */
  patient_relation?: string | null;
}

/**
 * ชื่อแพลตฟอร์มเขียน display_name ได้เมื่อเจ้าหน้าที่ไม่ได้ตั้งชื่อเอง
 * ผูก HN แล้วยังอัปเดตได้ เพราะชื่อ HIS อยู่คนละคอลัมน์ และ display_name ใช้กลับมาเมื่อยกเลิกการผูก
 */
export const platformMayWriteDisplayName = (c: ContactNameFields | null | undefined) =>
  !c || (!c.name_locked && c.name_source !== "staff");

/** เจ้าหน้าที่แก้ชื่อได้เมื่อยังไม่ผูก HN ผูกแล้วชื่อ HIS ล็อกไว้ ต้องยกเลิกการผูกก่อน */
export const staffMayRename = (c: ContactNameFields | null | undefined) => !c?.hn;

/** หลังยกเลิกการผูก HN */
export const sourceAfterUnlink = (c: ContactNameFields): NameSource => (c.name_locked ? "staff" : "platform");

/**
 * primary = "{ชื่อ นามสกุล} · HN {hn}" เมื่อผูก HN แล้ว (บัญชีญาติต่อท้าย " (ญาติ)") ไม่งั้นชื่อเดิม
 * secondary = ชื่อจากแพลตฟอร์ม (แสดงเล็กสีจาง) เมื่อต่างจาก primary
 */
export function contactLabel(c: ContactNameFields | null | undefined, fallback = "ลูกค้า"): { primary: string; secondary: string | null } {
  const base = c?.display_name?.trim() || c?.platform_name?.trim() || fallback;
  if (!c?.hn) {
    const platform = c?.platform_name?.trim();
    return { primary: base, secondary: platform && platform !== base ? platform : null };
  }
  // เจ้าหน้าที่ตั้งชื่อแชทเองไว้: ผูก HN แล้วก็ไม่เขียนทับชื่อ
  if (c.name_locked && c.display_name?.trim()) {
    const platform = c.platform_name?.trim() || null;
    return { primary: c.display_name.trim(), secondary: platform && platform !== c.display_name.trim() ? platform : null };
  }
  const name = c.patient_full_name?.trim() || base;
  const platform = c.platform_name?.trim() || c.display_name?.trim() || null;
  const relative = c.patient_relation === "relative" ? " (ญาติ)" : "";
  return { primary: `${name} · HN ${c.hn}${relative}`, secondary: platform && platform !== name ? platform : null };
}

export const contactName = (c: ContactNameFields | null | undefined, fallback = "ลูกค้า") => contactLabel(c, fallback).primary;
