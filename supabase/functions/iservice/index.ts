// เรียก iService จากหน้า "ทำนัดใหม่": รายการ visit วันนี้ ค้นหาคนไข้เก่า และเบอร์โทรจาก HN
// เรียกด้วย session ของเจ้าหน้าที่ (supabase.functions.invoke) ตรวจสิทธิ์ด้วย is_appointment_staff()
// deploy: supabase functions deploy iservice --no-verify-jwt (ตรวจสิทธิ์เอง: session เจ้าหน้าที่ผ่าน is_appointment_staff() หรือ service role ของ server)
import { createClient } from "npm:@supabase/supabase-js@2";
import { bangkokToday, diagnose, searchPatients, visitsOn } from "../_shared/iservice.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** key ฝั่ง server ทั้งหมดของโปรเจกต์: SUPABASE_SERVICE_ROLE_KEY และทุกค่าใน SUPABASE_SECRET_KEYS (JSON) */
function serverKeys(): string[] {
  const keys: string[] = [];
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) keys.push(legacy);
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    const collect = (v: unknown) => {
      if (typeof v === "string" && v.length > 20) keys.push(v);
      else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(collect);
    };
    try { collect(JSON.parse(raw)); } catch { collect(raw); }
  }
  return keys;
}

/**
 * key ที่ส่งมามีสิทธิ์ service_role จริงไหม: verify_cron_secret เรียกได้เฉพาะ service_role (migration 040)
 * key ของผู้ใช้หรือ anon จะได้ permission denied
 */
async function hasServiceRole(auth: string): Promise<boolean> {
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key || key.split(".").length === 3 && !key.startsWith("sb_") && isUserJwt(key)) return false;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
  const { error } = await sb.rpc("verify_cron_secret", { p_secret: "" });
  return !error;
}

/** JWT ของผู้ใช้ที่ล็อกอิน (role authenticated) ไม่ต้องลอง */
function isUserJwt(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.role === "authenticated";
  } catch {
    return false;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  // server ของ DocDesk เรียกด้วย service role ตอนผูก HN เพื่อเอาชื่อจาก HIS เอง
  // รับทั้ง service role แบบเดิม (JWT) และ secret key แบบใหม่ (sb_secret_…) ที่แอปบน Vercel อาจใช้
  const isServer = serverKeys().some((k) => auth === `Bearer ${k}`) || (await hasServiceRole(auth));
  if (!isServer) {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    });
    const { data: allowed } = await sb.rpc("is_appointment_staff");
    if (allowed !== true) return json({ error: "forbidden" }, 403);
  }

  const b = await req.json().catch(() => ({})) as { action?: string; q?: string; hn?: string };
  try {
    // ตรวจการเชื่อมต่อ: เรียกได้เฉพาะ server ของ DocDesk (ผ่าน /api/appointments/iservice-check ของแอดมิน)
    if (b.action === "diagnose") {
      if (!isServer) return json({ error: "forbidden" }, 403);
      return json(await diagnose(bangkokToday(), (b.q ?? "").trim().slice(0, 30)));
    }
    if (b.action === "visits") {
      const visits = await visitsOn(bangkokToday());
      // ล่าสุดก่อน
      visits.sort((a, z) => z.time.localeCompare(a.time) || z.seq - a.seq);
      return json({ visits });
    }
    if (b.action === "patients") {
      const q = (b.q ?? "").trim().slice(0, 60);
      if (q.length < 2) return json({ patients: [] });
      return json({ patients: await searchPatients(q) });
    }
    if (b.action === "patient") {
      const hn = (b.hn ?? "").trim().slice(0, 30);
      if (!hn) return json({ patient: null });
      const found = (await searchPatients(hn)).find((p) => p.hn === hn) ?? null;
      return json({ patient: found });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    // ไม่ส่งรายละเอียดซึ่งอาจมี URL หรือ token ออกไป
    console.error("iservice failed", b.action, e instanceof Error ? e.message : e);
    return json({ error: "เชื่อมต่อ iService ไม่สำเร็จ" }, 502);
  }
});
