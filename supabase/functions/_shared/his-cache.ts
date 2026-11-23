// cache ข้อมูลจาก iService ใน DocDesk ใช้ตอน iService ล่ม (เขียนด้วย service role อ่านได้เฉพาะเจ้าหน้าที่ ไม่ส่งเข้า AI)
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Visit } from "./iservice.ts";
import type { DrugRow } from "./his-records.ts";

/** เก็บ 1 ปี: ใช้เป็นประวัติการมาตรวจในกล่องข้อมูลลูกค้าด้วย */
export const VISIT_RETENTION_DAYS = 365;

export async function saveVisits(db: SupabaseClient, visits: Visit[]) {
  const rows = visits.filter((v) => v.vn && v.hn).map((v) => ({
    vn: v.vn, hn: v.hn.trim(), patient_name: v.name || null, visit_date: v.date, visit_time: v.time || null,
    doctor_name: v.doctor.replace(/\s+/g, " ").trim() || null, fetched_at: new Date().toISOString(),
    // ค่าว่าง = ไม่เขียนทับของเดิม
    ...(v.rights ? { rights: v.rights.trim() } : {}),
    ...(v.diagnosis ? { diagnosis: v.diagnosis.trim() } : {}),
    ...(v.age != null ? { age_y: v.age } : {}),
  }));
  if (!rows.length) return;
  const { error } = await db.from("his_visit_cache").upsert(rows, { onConflict: "vn" });
  if (error) console.error("visit cache failed", error.code);
  await touchProviders(db, rows.map((r) => r.doctor_name));
}

/** ชื่อแพทย์ที่พบใน visit → ตาราง providers (ตัวเลือก "ผู้นัด") ทำความสะอาด/รวมซ้ำในฐานข้อมูล */
export async function touchProviders(db: SupabaseClient, names: (string | null)[]) {
  const list = [...new Set(names.map((n) => (n ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (!list.length) return;
  const { error } = await db.rpc("touch_providers", { p_names: list });
  if (error) console.error("providers update failed", error.code);
}

export async function cachedVisits(db: SupabaseClient, date: string): Promise<{ visits: Visit[]; at: string | null }> {
  const { data } = await db.from("his_visit_cache").select("vn, hn, patient_name, visit_date, visit_time, doctor_name, fetched_at").eq("visit_date", date);
  const rows = (data ?? []) as { vn: string; hn: string; patient_name: string | null; visit_date: string; visit_time: string | null; doctor_name: string | null; fetched_at: string }[];
  const at = rows.reduce<string | null>((m, r) => (!m || r.fetched_at > m ? r.fetched_at : m), null);
  return {
    at,
    visits: rows.map((r) => ({ hn: r.hn, name: r.patient_name ?? "", doctor: r.doctor_name ?? "", time: r.visit_time ?? "", phone: "", seq: 0, vn: r.vn, date: r.visit_date })),
  };
}

/** ลบ visit และยาเก่ากว่า VISIT_RETENTION_DAYS */
export async function pruneVisits(db: SupabaseClient, today: string) {
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - VISIT_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  await db.from("his_visit_cache").delete().lt("visit_date", cutoff);
  await db.from("his_visit_drug_cache").delete().lt("visit_date", cutoff);
}

/** ยาที่ได้ต่อครั้ง (vn + icode) เขียนทับรายการเดิมของ VN นั้นด้วยค่าล่าสุดจาก iService */
export async function saveDrugs(db: SupabaseClient, drugs: DrugRow[]): Promise<number> {
  const rows = drugs.filter((d) => d.vn && d.icode && d.visit_date).map((d) => ({ ...d, fetched_at: new Date().toISOString() }));
  let saved = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from("his_visit_drug_cache").upsert(chunk, { onConflict: "vn,icode" });
    if (error) { console.error("drug cache failed", error.code); continue; }
    saved += chunk.length;
  }
  return saved;
}

/** เติมการวินิจฉัยย้อนหลังให้ visit ที่อยู่ใน cache แล้ว · ไม่เขียนทับค่าที่มีอยู่ */
export async function fillMissingDiagnosis(db: SupabaseClient, visits: Visit[]): Promise<number> {
  const withDx = visits.filter((v) => v.vn && v.diagnosis);
  if (!withDx.length) return 0;
  let updated = 0;
  for (let i = 0; i < withDx.length; i += 500) {
    const chunk = withDx.slice(i, i + 500);
    const { data } = await db.from("his_visit_cache").select("vn").in("vn", chunk.map((v) => v.vn)).is("diagnosis", null);
    const missing = new Set(((data ?? []) as { vn: string }[]).map((r) => r.vn));
    for (const v of chunk) {
      if (!missing.has(v.vn)) continue;
      const { error } = await db.from("his_visit_cache").update({ diagnosis: v.diagnosis!.trim() }).eq("vn", v.vn).is("diagnosis", null);
      if (!error) updated++;
    }
  }
  return updated;
}
