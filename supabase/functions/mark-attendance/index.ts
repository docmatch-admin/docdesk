// pg_cron เรียกทุกวัน 21:00 (เวลาไทย): เทียบนัดวันนี้กับ visit ใน iService
// มี visit ของ HN นั้น → attended ไม่มี → no_show ไม่ส่งข้อความหาคนไข้
// deploy: supabase functions deploy mark-attendance --no-verify-jwt (ตรวจ x-cron-secret กับ Vault ผ่าน verify_cron_secret)
import { createClient } from "npm:@supabase/supabase-js@2";
import { bangkokToday, normalizeName, samePhone, searchPatients, visitsOn } from "../_shared/iservice.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  // ค่าลับอยู่ใน Supabase Vault (docdesk_cron_secret) pg_cron อ่านจาก Vault ตอนเรียก
  const { data: ok } = await db.rpc("verify_cron_secret", { p_secret: req.headers.get("x-cron-secret") ?? "" });
  if (ok !== true) return json({ error: "unauthorized" }, 401);
  const today = bangkokToday();
  const { data: rows, error } = await db.from("appointments").select("id, hn, status, patient_name, phone")
    .eq("appoint_date", today).in("status", ["scheduled", "confirmed", "reschedule_requested"]);
  if (error) return json({ error: "อ่านนัดไม่สำเร็จ" }, 500);
  const due = (rows ?? []) as { id: string; hn: string | null; status: string; patient_name: string; phone: string | null }[];
  if (!due.length) return json({ date: today, attended: 0, no_show: 0, suggested: 0 });

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
  const result = { date: today, attended: 0, no_show: 0, suggested: 0 };
  const now = new Date().toISOString();
  // HN ที่มีนัดใน DocDesk อยู่แล้ว ไม่ใช่คนไข้ใหม่
  const knownHns = new Set(due.map((a) => a.hn?.trim()).filter(Boolean));
  for (const a of due) {
    if (!a.hn?.trim()) {
      // คนไข้ใหม่ที่นัดจากแชท: visit วันนี้ที่ชื่อตรง (และเช็กเบอร์จาก patient_list ถ้ามี) → เสนอให้แอดมินยืนยัน
      const target = normalizeName(a.patient_name);
      const candidates = target.length >= 4
        ? visits.filter((v) => !knownHns.has(v.hn.trim()) && normalizeName(v.name) === target)
        : [];
      if (candidates.length) {
        for (const v of candidates.slice(0, 3)) {
          let matchedBy = "name";
          if (a.phone) {
            const p = await searchPatients(v.hn).then((list) => list.find((x) => x.hn === v.hn)).catch(() => undefined);
            if (p?.phone && samePhone(p.phone, a.phone)) matchedBy = "name_phone";
          }
          const { error: insErr } = await db.from("appointment_hn_matches")
            .upsert({ appointment_id: a.id, hn: v.hn.trim(), his_name: v.name, matched_by: matchedBy }, { onConflict: "appointment_id,hn", ignoreDuplicates: true });
          if (insErr) console.error("match insert failed", insErr.code);
        }
        await db.from("appointment_events").insert({ appointment_id: a.id, kind: "hn_match_suggested", actor: "system", detail: { candidates: candidates.length } });
        result.suggested++;
        // รอแอดมินยืนยัน ยังไม่เปลี่ยนสถานะ
        continue;
      }
      const { data: updated } = await db.from("appointments").update({ status: "no_show", updated_at: now })
        .eq("id", a.id).eq("status", a.status).select("id");
      if (updated?.length) {
        await db.from("appointment_events").insert({ appointment_id: a.id, kind: "no_show", actor: "system", detail: { source: "ovst_list", reason: "ไม่พบ visit ที่ชื่อตรง" } });
        result.no_show++;
      }
      continue;
    }
    const status = came.has(a.hn.trim()) ? "attended" : "no_show";
    const { data: updated } = await db.from("appointments").update({ status, updated_at: now })
      .eq("id", a.id).eq("status", a.status).select("id");
    if (!updated?.length) continue;
    await db.from("appointment_events").insert({ appointment_id: a.id, kind: status, actor: "system", detail: { source: "ovst_list" } });
    result[status]++;
  }
  return json(result);
});
