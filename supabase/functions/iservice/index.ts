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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  // server ของ DocDesk เรียกด้วย service role ตอนผูก HN เพื่อเอาชื่อจาก HIS เอง
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const isServer = !!serviceKey && auth === `Bearer ${serviceKey}`;
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
      return json(await diagnose(bangkokToday()));
    }
    if (b.action === "visits") {
      const visits = await visitsOn(bangkokToday());
      // ล่าสุดก่อน
      visits.sort((a, z) => z.time.localeCompare(a.time));
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
