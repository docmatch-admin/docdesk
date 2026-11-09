// pg_cron เรียกทุกชั่วโมง: ตัดสินมาตามนัด/ไม่มาของวันที่ผ่านเวลาปิดแล้ว (วันนี้หลัง 21:00 หรือวันก่อนหน้าที่ยังค้าง)
// มี visit ของ HN นั้น → attended ไม่มี → no_show ไม่ส่งข้อความหาคนไข้
// ดึง ovst_list ไม่ได้ (iService ล่ม) → ห้ามตัดสิน no_show ลองใหม่รอบถัดไปจนสำเร็จ (ย้อนหลังสูงสุด 7 วัน)
// deploy: supabase functions deploy mark-attendance --no-verify-jwt (ตรวจ x-cron-secret กับ Vault ผ่าน verify_cron_secret)
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { bangkokToday, normalizeName, samePhone, searchPatients, visitsOn, type Visit } from "../_shared/iservice.ts";
import { saveVisits } from "../_shared/his-cache.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const DECIDE_AFTER_HOUR = 21;
const LOOKBACK_DAYS = 7;
const OPEN = ["scheduled", "confirmed", "reschedule_requested"];

const bangkokHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", hour12: false }).format(new Date()).replace("24", "0"));
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type Due = { id: string; hn: string | null; status: string; patient_name: string; phone: string | null };

async function decideDate(db: SupabaseClient, date: string, due: Due[], visits: Visit[]) {
  const came = new Set(visits.map((v) => v.hn.trim()));
  const result = { date, attended: 0, no_show: 0, suggested: 0 };
  const now = new Date().toISOString();
  // HN ที่มีนัดใน DocDesk อยู่แล้ว ไม่ใช่คนไข้ใหม่
  const knownHns = new Set(due.map((a) => a.hn?.trim()).filter(Boolean));
  for (const a of due) {
    if (!a.hn?.trim()) {
      // คนไข้ใหม่ที่นัดจากแชท: visit วันนัดที่ชื่อตรง (และเช็กเบอร์จาก patient_list ถ้ามี) → เสนอให้แอดมินยืนยัน
      const target = normalizeName(a.patient_name);
      const candidates = target.length >= 4 ? visits.filter((v) => !knownHns.has(v.hn.trim()) && normalizeName(v.name) === target) : [];
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
        continue;
      }
      const { data: updated } = await db.from("appointments").update({ status: "no_show", updated_at: now }).eq("id", a.id).eq("status", a.status).select("id");
      if (updated?.length) {
        await db.from("appointment_events").insert({ appointment_id: a.id, kind: "no_show", actor: "system", detail: { source: "ovst_list", reason: "ไม่พบ visit ที่ชื่อตรง" } });
        result.no_show++;
      }
      continue;
    }
    const status = came.has(a.hn.trim()) ? "attended" : "no_show";
    const { data: updated } = await db.from("appointments").update({ status, updated_at: now }).eq("id", a.id).eq("status", a.status).select("id");
    if (!updated?.length) continue;
    await db.from("appointment_events").insert({ appointment_id: a.id, kind: status, actor: "system", detail: { source: "ovst_list" } });
    result[status as "attended" | "no_show"]++;
  }
  return result;
}

Deno.serve(async (req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  // ค่าลับอยู่ใน Supabase Vault (docdesk_cron_secret) pg_cron อ่านจาก Vault ตอนเรียก
  const { data: ok } = await db.rpc("verify_cron_secret", { p_secret: req.headers.get("x-cron-secret") ?? "" });
  if (ok !== true) return json({ error: "unauthorized" }, 401);

  const today = bangkokToday();
  // วันนี้ตัดสินหลัง 21:00 เท่านั้น วันก่อนหน้าตัดสินได้เลย
  const lastDate = bangkokHour() >= DECIDE_AFTER_HOUR ? today : addDays(today, -1);
  const { data: openRows, error } = await db.from("appointments").select("appoint_date")
    .gte("appoint_date", addDays(today, -LOOKBACK_DAYS)).lte("appoint_date", lastDate).in("status", OPEN);
  if (error) return json({ error: "อ่านนัดไม่สำเร็จ" }, 500);
  const { data: doneRows } = await db.from("attendance_runs").select("visit_date").not("done_at", "is", null)
    .gte("visit_date", addDays(today, -LOOKBACK_DAYS));
  const done = new Set(((doneRows ?? []) as { visit_date: string }[]).map((r) => r.visit_date));
  const dates = [...new Set(((openRows ?? []) as { appoint_date: string }[]).map((r) => r.appoint_date))].filter((d) => !done.has(d)).sort();

  const results: unknown[] = [];
  for (const date of dates) {
    const { data: rows } = await db.from("appointments").select("id, hn, status, patient_name, phone").eq("appoint_date", date).in("status", OPEN);
    const due = (rows ?? []) as Due[];
    const { data: run } = await db.from("attendance_runs").select("attempts").eq("visit_date", date).maybeSingle();
    const attempts = ((run?.attempts as number | undefined) ?? 0) + 1;
    let visits: Visit[];
    try {
      visits = await visitsOn(date);
      // ไม่มี visit เลยทั้งวันแต่มีนัด น่าจะเป็นปัญหาของระบบมากกว่าคนไข้ไม่มาทุกคน ลองใหม่รอบถัดไป
      if (!visits.length) throw new Error("ไม่พบ visit ของวันนี้");
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 200) : String(e);
      console.error("ovst_list failed", date, message);
      await db.from("attendance_runs").upsert({ visit_date: date, attempts, last_error: message, updated_at: new Date().toISOString() }, { onConflict: "visit_date" });
      results.push({ date, retry: true, error: message });
      continue;
    }
    await saveVisits(db, visits);
    results.push(await decideDate(db, date, due, visits));
    await db.from("attendance_runs").upsert({ visit_date: date, attempts, done_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }, { onConflict: "visit_date" });
  }
  return json({ today, processed: results });
});
