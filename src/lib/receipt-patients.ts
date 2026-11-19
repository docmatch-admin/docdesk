// ชื่อคนไข้จากระบบใบเสร็จ (Supabase happiwell-ai) → patients ของ DocDesk ใช้ค้นด้วยชื่อตอนทำนัด
// RPC docdesk_patient_names(p_token, p_since) → [{ hn (9 หลัก), full_name, last_visit }]
// เติมชื่อเฉพาะแถวที่ยังไม่มีชื่อ หรือชื่อเดิมมาจากแหล่งนี้ (name_source = 'receipt') — ไม่ทับชื่อจาก iService / ที่เจ้าหน้าที่แก้
import { supabaseAdmin } from "./supabase/admin";

const RCPT_URL = process.env.RCPT_SUPABASE_URL ?? "https://brfddpdynusxiiqopark.supabase.co";
// publishable key (เปิดเผยได้) · ค่าลับคือ RCPT_PATIENT_TOKEN ที่ RPC ตรวจเอง
const RCPT_KEY = process.env.RCPT_PUBLISHABLE_KEY ?? "sb_publishable_CgCtkWyo6mUkJy7RGPEBQQ_h2eC1A4j";
export const RECEIPT_SOURCE = "receipt";
const BATCH = 500;

export interface ReceiptPatient { hn: string; full_name: string | null; last_visit?: string | null }
interface Existing { hn: string; full_name: string | null; name_source: string | null }

/** HN ตัวเลข 1–15 หลัก → 9 หลักเติม 0 (เหมือน patients ของ DocDesk) · อย่างอื่น = null */
export const receiptHn = (hn: unknown): string | null => {
  const t = String(hn ?? "").trim();
  if (!/^\d{1,15}$/.test(t)) return null;
  return t.length < 9 ? t.padStart(9, "0") : t;
};
const cleanName = (n: unknown) => String(n ?? "").replace(/\s+/g, " ").trim();

/**
 * แผนการนำเข้า: แถวใหม่ = เพิ่ม · มีอยู่แล้วและชื่อว่าง/มาจากใบเสร็จเดิม = อัปเดตเมื่อชื่อเปลี่ยน · ชื่อจากแหล่งอื่น = ไม่แตะ
 */
export function planReceiptImport(incoming: ReceiptPatient[], existing: Map<string, Existing>) {
  const write = new Map<string, { hn: string; full_name: string }>();
  let invalid = 0, unchanged = 0, protectedRows = 0, inserted = 0, updated = 0;
  for (const p of incoming) {
    const hn = receiptHn(p.hn);
    const name = cleanName(p.full_name);
    if (!hn || !name) { invalid++; continue; }
    if (write.has(hn)) continue;
    const ex = existing.get(hn);
    if (!ex) { write.set(hn, { hn, full_name: name }); inserted++; continue; }
    const mine = !ex.full_name?.trim() || ex.name_source === RECEIPT_SOURCE;
    if (!mine) { protectedRows++; continue; }
    if (cleanName(ex.full_name) === name && ex.name_source === RECEIPT_SOURCE) { unchanged++; continue; }
    write.set(hn, { hn, full_name: name });
    updated++;
  }
  return { rows: [...write.values()], inserted, updated, unchanged, protected: protectedRows, invalid };
}

export async function fetchReceiptPatients(since: string | null): Promise<ReceiptPatient[]> {
  const token = process.env.RCPT_PATIENT_TOKEN;
  if (!token) throw new Error("ยังไม่ได้ตั้ง RCPT_PATIENT_TOKEN");
  const res = await fetch(`${RCPT_URL}/rest/v1/rpc/docdesk_patient_names`, {
    method: "POST",
    headers: { apikey: RCPT_KEY, Authorization: `Bearer ${RCPT_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: token, p_since: since }),
    signal: AbortSignal.timeout(30_000),
  });
  // ไม่ส่งรายละเอียดคำตอบ (อาจมีข้อมูลคนไข้) ออกไป
  if (!res.ok) throw new Error(`ระบบใบเสร็จตอบ ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error("ระบบใบเสร็จตอบไม่ใช่รายการ");
  return j as ReceiptPatient[];
}

/** ดึงแล้วนำเข้า · since = null ดึงทั้งหมด */
export async function importReceiptPatients(since: string | null) {
  const incoming = await fetchReceiptPatients(since);
  const db = supabaseAdmin();
  const hns = [...new Set(incoming.map((p) => receiptHn(p.hn)).filter((h): h is string => !!h))];
  const existing = new Map<string, Existing>();
  for (let i = 0; i < hns.length; i += BATCH) {
    const { data, error } = await db.from("patients").select("hn, full_name, name_source").in("hn", hns.slice(i, i + BATCH));
    if (error) throw new Error(`อ่าน patients ไม่สำเร็จ: ${error.message}`);
    for (const r of (data ?? []) as Existing[]) existing.set(r.hn, r);
  }
  const plan = planReceiptImport(incoming, existing);
  const now = new Date().toISOString();
  for (let i = 0; i < plan.rows.length; i += BATCH) {
    // name_synced_at บอก trigger ว่าเป็นการเขียนจากแหล่งนี้ (คนอื่นแก้ชื่อ = name_source ล้างเอง)
    const chunk = plan.rows.slice(i, i + BATCH).map((r) => ({ ...r, name_source: RECEIPT_SOURCE, name_synced_at: now, updated_at: now }));
    const { error } = await db.from("patients").upsert(chunk, { onConflict: "hn" });
    if (error) throw new Error(`บันทึก patients ไม่สำเร็จ: ${error.message}`);
  }
  const { inserted, updated, unchanged, protected: protectedRows, invalid } = plan;
  return { since, fetched: incoming.length, inserted, updated, unchanged, protected: protectedRows, invalid };
}

/** วันที่ (เวลาไทย) ย้อนหลัง n วัน */
export const bangkokDaysAgo = (n: number, now = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(now - n * 86_400_000));
