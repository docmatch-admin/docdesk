import crypto from "node:crypto";
import { supabaseAdmin } from "./supabase/admin";

/** bcrypt เท่านั้น ($2a/$2b/$2y, cost 04-31) Supabase Auth รับรูปแบบนี้ */
export const BCRYPT_HASH = /^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HrCredentialPush { hr_employee_id: string; password_hash: string }

/** ตรวจ body จาก HR คืน null ถ้ารูปแบบไม่ถูกต้อง ไม่รับรหัสผ่านจริง รับเฉพาะ hash */
export function parseCredentialPush(body: unknown): HrCredentialPush | null {
  if (!body || typeof body !== "object") return null;
  const { hr_employee_id, password_hash } = body as Record<string, unknown>;
  if (typeof hr_employee_id !== "string" || !UUID.test(hr_employee_id)) return null;
  if (typeof password_hash !== "string" || !BCRYPT_HASH.test(password_hash)) return null;
  return { hr_employee_id, password_hash };
}

/** เทียบ secret แบบเวลาคงที่ ถ้ายังไม่ได้ตั้งค่า secret ปฏิเสธทุกคำขอ */
export function secretMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 24 || !header?.startsWith("Bearer ")) return false;
  const a = crypto.createHash("sha256").update(header.slice(7)).digest();
  const b = crypto.createHash("sha256").update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

export type CredentialResult = "updated" | "unmatched" | "inactive" | "admin" | "failed";

/**
 * ตั้งรหัสผ่านของบัญชีที่จับคู่กับพนักงาน HR (staff.hr_employee_id) ด้วย hash จาก HR
 * ไม่สร้างบัญชีใหม่ ต้องให้ admin จับคู่และกำหนดสิทธิ์ก่อน ล้าง session เก่าทุกครั้ง
 */
export async function applyHrCredential(push: HrCredentialPush): Promise<CredentialResult> {
  const db = supabaseAdmin();
  const { data: account } = await db.from("staff").select("id, active, role").eq("hr_employee_id", push.hr_employee_id).maybeSingle();
  if (!account) return "unmatched";
  if (!(account as { active: boolean }).active) return "inactive";
  // บัญชี admin ห้ามให้ระบบอื่นตั้งรหัสให้ ต้องเปลี่ยนในหน้าพนักงานของ DocDesk เท่านั้น
  if ((account as { role: string }).role === "admin") return "admin";
  const id = (account as { id: string }).id;
  const { error } = await db.auth.admin.updateUserById(id, { password_hash: push.password_hash });
  if (error) return "failed";
  // รหัสนี้เป็นรหัสจริงของพนักงานจาก HR ไม่ใช่รหัสชั่วคราว
  const { error: flagError } = await db.from("staff").update({ must_change_password: false }).eq("id", id);
  if (flagError) return "failed";
  await db.rpc("revoke_staff_sessions", { p_user: id });
  return "updated";
}
