import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const WEBCHAT_LIMITS = {
  perMinute: 5,
  perHour: 30,
  newSessionsPerIpPerHour: 3,
  /** 1 ครั้ง = 1 ข้อความที่เข้าระบบ AI (ใน 1 ข้อความอาจเรียก OpenAI หลายครั้ง: แปล, embedding, ร่างคำตอบ) */
  aiPerDay: 300,
  /** รูปทั้งระบบของช่องทางเว็บ นับตอนขอช่องอัปโหลด กันพื้นที่ Storage เต็ม ไม่รวมรูปจาก LINE/Meta/เจ้าหน้าที่ */
  imagesPerDay: 100,
};

const ALLOWED_ORIGINS = new Set(["https://happiwellclinic.com", "https://www.happiwellclinic.com"]);

/** รับเฉพาะเว็บคลินิกและ localhost (Origin ปลอมได้นอกเบราว์เซอร์ จึงไม่ได้แทน rate limit) */
export function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    return u.origin === origin && u.hostname === "localhost";
  } catch {
    return false;
  }
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const base = { Vary: "Origin" };
  if (!isAllowedOrigin(origin)) return base;
  return {
    ...base,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** ใช้ HMAC แทน hash เปล่า เพราะ IPv4 มีน้อยจนไล่ย้อนกลับได้ */
export function hashIp(ip: string, secret = process.env.IP_HASH_SECRET): string {
  if (!secret) throw new Error("ต้องตั้ง IP_HASH_SECRET");
  return crypto.createHmac("sha256", secret).update(ip).digest("hex");
}

export interface WebchatAdmission {
  allowed: boolean;
  ai_allowed: boolean;
  reason: "session_minute" | "session_hour" | "ip_new_sessions" | null;
}

/** ตรวจและนับข้อความแบบ atomic ก่อนเรียก AI ทุกครั้ง */
export async function admitWebchat(db: SupabaseClient, session: string, ipHash: string): Promise<WebchatAdmission> {
  const { data, error } = await db.rpc("webchat_admit", {
    p_session: session,
    p_ip_hash: ipHash,
    p_per_minute: WEBCHAT_LIMITS.perMinute,
    p_per_hour: WEBCHAT_LIMITS.perHour,
    p_new_sessions_per_hour: WEBCHAT_LIMITS.newSessionsPerIpPerHour,
    p_ai_per_day: WEBCHAT_LIMITS.aiPerDay,
  });
  if (error) throw error;
  return data as WebchatAdmission;
}

export interface WebchatImageAdmission {
  allowed: boolean;
  reason: WebchatAdmission["reason"] | "images_day";
}

/** รูป: ใช้ rate limit เดียวกับข้อความ แต่นับเพดานรูปรายวันแทนเพดาน AI */
export async function admitWebchatImage(db: SupabaseClient, session: string, ipHash: string): Promise<WebchatImageAdmission> {
  const { data, error } = await db.rpc("webchat_admit_image", {
    p_session: session,
    p_ip_hash: ipHash,
    p_per_minute: WEBCHAT_LIMITS.perMinute,
    p_per_hour: WEBCHAT_LIMITS.perHour,
    p_new_sessions_per_hour: WEBCHAT_LIMITS.newSessionsPerIpPerHour,
    p_images_per_day: WEBCHAT_LIMITS.imagesPerDay,
  });
  if (error) throw error;
  return data as WebchatImageAdmission;
}
