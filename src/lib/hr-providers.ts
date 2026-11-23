// รายชื่อแพทย์ให้ระบบ HR ดึงไป (GET /api/hr/providers) — ฟังก์ชันล้วน ไม่แตะฐานข้อมูล

/** แพทย์ที่ active = null (ยังไม่ได้ตั้ง) นับว่ายังทำงานถ้าเห็นในระบบภายในกี่วัน */
export const PROVIDER_RECENT_DAYS = 180;
const DAY_MS = 86_400_000;

/** ชื่อที่ไม่ใช่แพทย์จริง (iService ใส่มาเมื่อไม่ได้ระบุแพทย์) */
const NOT_A_NAME = new Set(["ไม่ระบุ", "ไม่ทราบ", "-", "unknown", "n/a"]);

export interface ProviderRow { name: string | null; last_seen_at: string | null; active: boolean | null }
export interface HrProvider { name: string; last_seen_at: string }

/**
 * active = true เสมอ · active = null เฉพาะที่เห็นภายใน 180 วัน · active = false ตัดทิ้ง
 * เรียงตามชื่อ · last_seen_at เป็น ISO (รูปแบบที่ edge function docdesk-providers ของ HR อ่าน)
 */
export function hrProviderList(rows: ProviderRow[], now = Date.now()): HrProvider[] {
  const since = now - PROVIDER_RECENT_DAYS * DAY_MS;
  const out: HrProvider[] = [];
  for (const r of rows) {
    const name = r.name?.trim();
    const seen = r.last_seen_at ? Date.parse(r.last_seen_at) : Number.NaN;
    if (!name || NOT_A_NAME.has(name.toLowerCase()) || r.active === false) continue;
    if (r.active !== true && !(Number.isFinite(seen) && seen >= since)) continue;
    out.push({ name, last_seen_at: Number.isFinite(seen) ? new Date(seen).toISOString() : new Date(0).toISOString() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "th"));
}
