// cache ข้อมูลจาก iService ใน DocDesk ใช้ตอน iService ล่ม (เขียนด้วย service role อ่านได้เฉพาะเจ้าหน้าที่ ไม่ส่งเข้า AI)
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Patient, Visit } from "./iservice.ts";

export const VISIT_RETENTION_DAYS = 90;

export async function saveVisits(db: SupabaseClient, visits: Visit[]) {
  const rows = visits.filter((v) => v.vn && v.hn).map((v) => ({
    vn: v.vn, hn: v.hn.trim(), patient_name: v.name || null, visit_date: v.date, visit_time: v.time || null,
    doctor_name: v.doctor.replace(/\s+/g, " ").trim() || null, fetched_at: new Date().toISOString(),
  }));
  if (!rows.length) return;
  const { error } = await db.from("his_visit_cache").upsert(rows, { onConflict: "vn" });
  if (error) console.error("visit cache failed", error.code);
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

export async function savePatients(db: SupabaseClient, patients: Patient[]) {
  const rows = patients.filter((p) => p.hn).map((p) => ({ hn: p.hn.trim(), full_name: p.name || null, phone: p.phone || null, fetched_at: new Date().toISOString() }));
  if (!rows.length) return;
  const { error } = await db.from("his_patient_cache").upsert(rows, { onConflict: "hn" });
  if (error) console.error("patient cache failed", error.code);
}

/** ค้นใน cache ด้วย HN (เต็มหรือตัด 0) ชื่อ หรือเบอร์ */
export async function cachedPatients(db: SupabaseClient, q: string): Promise<{ patients: Patient[]; at: string | null }> {
  const term = q.trim().replace(/[%,()]/g, " ");
  const digits = term.replace(/\D/g, "");
  const filters = [`full_name.ilike.%${term}%`, `hn.ilike.%${term}%`];
  if (digits.length >= 6) filters.push(`phone.ilike.%${digits}%`);
  const { data } = await db.from("his_patient_cache").select("hn, full_name, phone, fetched_at").or(filters.join(",")).limit(50);
  const rows = (data ?? []) as { hn: string; full_name: string | null; phone: string | null; fetched_at: string }[];
  const at = rows.reduce<string | null>((m, r) => (!m || r.fetched_at > m ? r.fetched_at : m), null);
  return { at, patients: rows.map((r) => ({ hn: r.hn, name: r.full_name ?? "", phone: r.phone ?? "" })) };
}

/** ลบ visit เก่ากว่า 90 วัน */
export async function pruneVisits(db: SupabaseClient, today: string) {
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - VISIT_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  await db.from("his_visit_cache").delete().lt("visit_date", cutoff);
}
