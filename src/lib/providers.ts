/**
 * ผู้นัด (แพทย์): รายชื่อจากชื่อแพทย์ใน visit ของ iService (ovst_list: doctor_dx/doctor) + ชื่อที่เคยใช้ในนัด
 * เก็บในตาราง providers (name, last_seen_at, active) · ฟอร์มนัดเริ่มที่ "— ไม่ระบุ —" ไม่เติมให้เอง
 */
export interface Provider { name: string; last_seen_at: string; active: boolean | null }

/** ไม่ปรากฏใน visit/นัดเกินกี่วันแล้วซ่อนจากตัวเลือก (เว้นแต่แอดมินเปิดไว้เอง) */
export const PROVIDER_STALE_DAYS = 180;

/** ยุบช่องว่างซ้อน ตัดหัวท้าย ไม่เกิน 120 ตัวอักษร (ความยาวเดียวกับช่อง provider ในนัด) */
export function cleanProviderName(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 120) : "";
}

/**
 * แสดงในตัวเลือกไหม: active = true แสดงเสมอ · false ซ่อนเสมอ (แอดมินตั้ง)
 * null (อัตโนมัติ) แสดงเมื่อพบภายใน 180 วัน
 */
export function providerVisible(p: Pick<Provider, "last_seen_at" | "active">, now = Date.now()): boolean {
  if (p.active === true) return true;
  if (p.active === false) return false;
  return now - Date.parse(p.last_seen_at) <= PROVIDER_STALE_DAYS * 86_400_000;
}

export interface ProviderOption { name: string; today: boolean }

/**
 * ตัวเลือกในฟอร์ม: แพทย์ที่ตรวจคนไข้รายนี้ใน visit วันนี้อยู่บนสุด (ป้าย "ตรวจวันนี้" แต่ไม่เลือกให้)
 * ที่เหลือเรียงตามที่พบล่าสุด · ค่าปัจจุบันของนัด (ถ้าถูกซ่อนแล้ว) ยังอยู่ในรายการให้เห็น
 */
export function providerOptions(list: Provider[], todayDoctors: string[], current?: string | null, now = Date.now()): ProviderOption[] {
  const key = (s: string) => cleanProviderName(s).toLocaleLowerCase("th");
  const today = new Set(todayDoctors.map(key).filter(Boolean));
  const visible = list.filter((p) => providerVisible(p, now)).sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  const out: ProviderOption[] = [];
  const seen = new Set<string>();
  const push = (name: string, isToday: boolean) => {
    const k = key(name);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ name: cleanProviderName(name), today: isToday });
  };
  for (const d of todayDoctors) push(d, true);
  for (const p of visible) push(p.name, today.has(key(p.name)));
  if (current) push(current, today.has(key(current)));
  return out;
}

/** ค้นในตัวเลือก (ไม่สนตัวพิมพ์ ช่องว่าง และคำนำหน้า นพ./พญ.) */
export function filterProviders(options: ProviderOption[], q: string): ProviderOption[] {
  const norm = (s: string) => s.toLocaleLowerCase("th").replace(/\s+/g, "").replace(/^(นพ|พญ|ทพ|ทพญ|ภก|ภญ|dr)\.?/i, "");
  const term = norm(q);
  return term ? options.filter((o) => norm(o.name).includes(term) || o.name.toLocaleLowerCase("th").includes(q.trim().toLocaleLowerCase("th"))) : options;
}
