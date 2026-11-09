// pg_cron เรียกทุกวัน 21:00 (เวลาไทย): เทียบนัดวันนี้กับ visit ใน iService
// มี visit ของ HN นั้น → attended ไม่มี → no_show ไม่ส่งข้อความหาคนไข้
// deploy: supabase functions deploy mark-attendance --no-verify-jwt (ตรวจ x-cron-secret เอง)
import { createClient } from "npm:@supabase/supabase-js@2";
import { bangkokToday, visitsOn } from "../_shared/iservice.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return json({ error: "unauthorized" }, 401);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const today = bangkokToday();
  const { data: rows, error } = await db.from("appointments").select("id, hn, status")
    .eq("appoint_date", today).in("status", ["scheduled", "confirmed", "reschedule_requested"]);
  if (error) return json({ error: "อ่านนัดไม่สำเร็จ" }, 500);
  const due = (rows ?? []) as { id: string; hn: string | null; status: string }[];
  if (!due.length) return json({ date: today, attended: 0, no_show: 0, skipped: 0 });

  let visits;
  try {
    visits = await visitsOn(today);
  } catch (e) {
    // อ่าน visit ไม่ได้ ห้ามทำเครื่องหมายไม่มาตามนัดทั้งหมด
    console.error("ovst_list failed", e instanceof Error ? e.message : e);
    return json({ error: "อ่าน visit จาก iService ไม่สำเร็จ" }, 502);
  }
  // ไม่มี visit เลยทั้งวันแต่มีนัด น่าจะเป็นปัญหาของระบบมากกว่าคนไข้ไม่มาทุกคน
  if (!visits.length) return json({ error: "ไม่พบ visit วันนี้ ไม่ได้เปลี่ยนสถานะนัด", date: today }, 409);

  const came = new Set(visits.map((v) => v.hn.trim()));
  const result = { date: today, attended: 0, no_show: 0, skipped: 0 };
  const now = new Date().toISOString();
  for (const a of due) {
    // นัดที่กรอกเองไม่มี HN เทียบไม่ได้ ให้เจ้าหน้าที่ดูเอง
    if (!a.hn?.trim()) { result.skipped++; continue; }
    const status = came.has(a.hn.trim()) ? "attended" : "no_show";
    const { data: updated } = await db.from("appointments").update({ status, updated_at: now })
      .eq("id", a.id).eq("status", a.status).select("id");
    if (!updated?.length) continue;
    await db.from("appointment_events").insert({ appointment_id: a.id, kind: status, actor: "system", detail: { source: "ovst_list" } });
    result[status]++;
  }
  return json(result);
});
