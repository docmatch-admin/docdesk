/**
 * ชื่อลูกค้าใน DocDesk: ลำดับความสำคัญ his > staff > ai > platform
 * ใช้ได้ทั้ง server และหน้าเว็บ
 */
export type NameSource = "his" | "staff" | "ai" | "platform";

const RANK: Record<NameSource, number> = { platform: 0, ai: 1, staff: 2, his: 3 };
const sourceOf = (s: unknown): NameSource => (s === "his" || s === "staff" || s === "ai" ? s : "platform");

/** ชื่อจากแหล่ง incoming เขียนทับชื่อปัจจุบันได้ไหม */
export const canOverwriteName = (current: unknown, incoming: NameSource) => RANK[incoming] >= RANK[sourceOf(current)];

export interface ContactNameFields {
  display_name?: string | null;
  platform_name?: string | null;
  patient_full_name?: string | null;
  hn?: string | null;
  name_source?: string | null;
  name_locked?: boolean | null;
}

/**
 * ชื่อแพลตฟอร์มเขียน display_name ได้เมื่อยังไม่มีชื่อที่สำคัญกว่าใน display_name
 * ผูก HN แล้วยังอัปเดต display_name ได้ เพราะชื่อ HIS อยู่คนละคอลัมน์ และ display_name ใช้กลับมาเมื่อยกเลิกการผูก
 */
export const platformMayWriteDisplayName = (c: ContactNameFields | null | undefined) =>
  !c || (!c.name_locked && c.name_source !== "staff" && c.name_source !== "ai");

/** AI ตั้งชื่อเองได้เฉพาะเมื่อชื่อยังมาจากแพลตฟอร์ม ห้ามทับชื่อจาก HIS หรือที่เจ้าหน้าที่ตั้ง */
export const aiMayWriteName = (c: ContactNameFields | null | undefined) => !!c && !c.name_locked && canOverwriteName(c.name_source, "ai");

/** หลังยกเลิกการผูก HN */
export const sourceAfterUnlink = (c: ContactNameFields): NameSource => (c.name_locked ? "staff" : "platform");

/**
 * primary = "{ชื่อ นามสกุล} · HN {hn}" เมื่อผูก HN แล้ว ไม่งั้นชื่อเดิม
 * secondary = ชื่อจากแพลตฟอร์ม (แสดงเล็กสีจาง) เมื่อต่างจาก primary
 */
export function contactLabel(c: ContactNameFields | null | undefined, fallback = "ลูกค้า"): { primary: string; secondary: string | null } {
  const base = c?.display_name?.trim() || c?.platform_name?.trim() || fallback;
  if (!c?.hn) {
    const platform = c?.platform_name?.trim();
    return { primary: base, secondary: platform && platform !== base ? platform : null };
  }
  const name = c.patient_full_name?.trim() || base;
  const platform = c.platform_name?.trim() || c.display_name?.trim() || null;
  return { primary: `${name} · HN ${c.hn}`, secondary: platform && platform !== name ? platform : null };
}

export const contactName = (c: ContactNameFields | null | undefined, fallback = "ลูกค้า") => contactLabel(c, fallback).primary;
