/** ประวัติการแก้ตั้งค่า (settings_audit): สรุปค่าเก่า→ใหม่ให้อ่านง่าย */
export interface AuditRow {
  id: number; actor_id: string | null; actor_name: string | null; section: string; table_name: string;
  record_key: string | null; action: "insert" | "update" | "delete"; old_value: Record<string, unknown> | null; new_value: Record<string, unknown> | null; created_at: string;
}

export const AUDIT_TABLE_LABEL: Record<string, string> = {
  settings: "ตั้งค่า", channels: "ช่องทาง", tags: "แท็ก", tag_rules: "กฎติดแท็ก", appointment_purposes: "เหตุผลนัด",
  clinic_hours: "เวลาเปิดคลินิก", clinic_closures: "วันหยุดพิเศษ", appointment_series_templates: "Template ชุดนัด", providers: "ผู้นัด",
};
export const AUDIT_ACTION_LABEL = { insert: "เพิ่ม", update: "แก้", delete: "ลบ" } as const;

/** คอลัมน์ที่เปลี่ยนเองทุกครั้ง ไม่ใช่สิ่งที่ผู้ใช้แก้ */
const NOISE = new Set(["updated_at", "created_at", "id", "created_by"]);

/** ไม่มีค่า / null / ว่าง ถือว่าเท่ากัน (ไม่นับเป็นการเปลี่ยน) */
const same = (a: unknown, b: unknown) => {
  const n = (v: unknown) => (v === undefined || v === null || v === "" ? null : v);
  return JSON.stringify(n(a)) === JSON.stringify(n(b));
};

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "–";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
};

/**
 * รายการที่เปลี่ยน: ตาราง settings ดูที่ value (เทียบคีย์ย่อยถ้าเป็น object) ตารางอื่นเทียบทุกคอลัมน์
 * เพิ่ม/ลบ แสดงค่าทั้งแถวฝั่งเดียว
 */
export function auditChanges(r: Pick<AuditRow, "table_name" | "old_value" | "new_value">): { field: string; from: string; to: string }[] {
  let oldV: unknown = r.old_value;
  let newV: unknown = r.new_value;
  if (r.table_name === "settings") { oldV = r.old_value?.value; newV = r.new_value?.value; }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(oldV) && !isObj(newV)) {
    return same(oldV, newV) ? [] : [{ field: "ค่า", from: show(oldV), to: show(newV) }];
  }
  const o = isObj(oldV) ? oldV : {};
  const n = isObj(newV) ? newV : {};
  return [...new Set([...Object.keys(o), ...Object.keys(n)])]
    .filter((k) => !NOISE.has(k) && !same(o[k], n[k]))
    .map((k) => ({ field: k, from: show(o[k]), to: show(n[k]) }));
}
