import { lookupHisPatient } from "./his";
import { hnVariants } from "./patient-link-store";
import { supabaseAdmin } from "./supabase/admin";

/**
 * ชื่อ + เบอร์ของคนไข้สำหรับเติมฟอร์มนัด (ทุกทางเข้า: คนไข้วันนี้ ค้นหา กล่องขวาของแชท แก้ไขนัด)
 * 1) iService list_patient ฝั่ง server ด้วย HN เต็ม 9 หลัก (timeout 5 วินาที)
 * 2) iService ล้ม/ไม่มีเบอร์ → เบอร์ในตาราง patients (บันทึกจากนัดครั้งก่อน)
 * คืนเฉพาะชื่อและเบอร์ ไม่มีเลขบัตรประชาชนหรือข้อมูลอื่นจาก HIS
 */
export type PhoneSource = "iservice" | "patients" | null;
export interface PatientContact { hn: string; full_name: string | null; phone: string | null; phone_source: PhoneSource }

export const ISERVICE_CONTACT_TIMEOUT_MS = 5_000;

/** HN 9 หลัก (เติม 0 ข้างหน้า) ถ้าเป็นตัวเลข */
export function fullHn(hn: string): string {
  const t = hn.trim();
  return /^\d+$/.test(t) ? t.replace(/^0+/, "").padStart(9, "0") : t;
}

export async function patientContact(hn: string, lookup = lookupHisPatient): Promise<PatientContact> {
  const full = fullHn(hn);
  const his = await lookup(full, ISERVICE_CONTACT_TIMEOUT_MS).catch(() => ({ status: "error" as const }));
  const hisName = his.status === "found" ? his.name.trim() || null : null;
  const hisPhone = his.status === "found" ? his.phone.trim() || null : null;
  if (hisPhone) return { hn: full, full_name: hisName, phone: hisPhone, phone_source: "iservice" };

  const { data } = await supabaseAdmin().from("patients").select("full_name, phone").in("hn", hnVariants(full)).limit(1).maybeSingle();
  const local = data as { full_name: string | null; phone: string | null } | null;
  const phone = local?.phone?.trim() || null;
  return { hn: full, full_name: hisName ?? (local?.full_name?.trim() || null), phone, phone_source: phone ? "patients" : null };
}
