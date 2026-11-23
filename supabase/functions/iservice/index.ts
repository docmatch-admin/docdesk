// เรียก iService จากหน้า "ทำนัดใหม่": รายการ visit วันนี้ ค้นหาคนไข้เก่า และเบอร์โทรจาก HN
// เรียกด้วย session ของเจ้าหน้าที่ (supabase.functions.invoke) ตรวจสิทธิ์ด้วย is_appointment_staff()
// deploy: supabase functions deploy iservice --no-verify-jwt (ตรวจสิทธิ์เอง: session เจ้าหน้าที่ผ่าน is_appointment_staff() หรือ service role ของ server)
import { createClient } from "npm:@supabase/supabase-js@2";
import { bangkokToday, classifySearch, diagnose, drugsBetween, listPatient, padHn, visitsBetween, visitsOn, withTimeout, type Patient } from "../_shared/iservice.ts";
import { cachedVisits, fillMissingDiagnosis, pruneVisits, saveDrugs, saveVisits, VISIT_RETENTION_DAYS } from "../_shared/his-cache.ts";
import { dateChunks } from "../_shared/his-records.ts";
import { nameSearchTerms } from "../_shared/patient-name.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

/**
 * คนไข้ในตาราง patients ของ DocDesk (ชื่อจากระบบใบเสร็จทุกคืน + ตอนบันทึกนัด/ผูกแชท) ใช้ค้นชื่อ และสำรองตอน iService ล่ม
 * ค้นชื่อ: ตัดคำนำหน้า (นาย/นาง/นางสาว/ด.ช./ด.ญ./คุณ) ทุกคำต้องเจอ → ค้นชื่ออย่างเดียว นามสกุลอย่างเดียว หรือทั้งคู่ได้ (index trigram, migration 064)
 */
async function docdeskPatients(admin: SupabaseClient, by: { name?: string; hn?: string; phone?: string }): Promise<Patient[]> {
  let q = admin.from("patients").select("hn, full_name, phone").order("full_name").limit(30);
  if (by.name) {
    const terms = nameSearchTerms(by.name);
    if (!terms.length) return [];
    for (const t of terms) q = q.ilike("full_name", `%${t}%`);
  } else if (by.hn) q = q.eq("hn", padHn(by.hn));
  else if (by.phone) q = q.eq("phone", by.phone.replace(/\D/g, ""));
  const { data } = await q;
  return ((data ?? []) as { hn: string; full_name: string | null; phone: string | null }[]).map((r) => ({ hn: r.hn, name: r.full_name ?? "", phone: r.phone ?? "" }));
}

/** ผลค้น: ป้าย LINE ✓ ถ้าผูกแชท LINE (ยังติดตาม) และนัดล่าสุด */
async function enrich(admin: SupabaseClient, list: Patient[]) {
  const hns = [...new Set(list.map((p) => p.hn))];
  if (!hns.length) return [];
  const [{ data: line }, { data: appts }] = await Promise.all([
    admin.from("contacts").select("hn, line_unfollowed_at, channels!inner(type)").in("hn", hns).eq("channels.type", "line"),
    admin.from("appointments").select("hn, appoint_date, status").in("hn", hns).neq("series_done", true).neq("status", "cancelled").order("appoint_date", { ascending: false }),
  ]);
  const linked = new Set(((line ?? []) as { hn: string; line_unfollowed_at: string | null }[]).filter((c) => !c.line_unfollowed_at).map((c) => c.hn));
  const last = new Map<string, string>();
  for (const a of (appts ?? []) as { hn: string; appoint_date: string }[]) if (!last.has(a.hn)) last.set(a.hn, a.appoint_date);
  return list.map((p) => ({ ...p, lineLinked: linked.has(p.hn), lastAppointment: last.get(p.hn) ?? null }));
}

/** iService ตอบช้ากว่านี้ถือว่าล่ม ใช้ cache */
const LIVE_TIMEOUT_MS = 8_000;

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
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // pg_cron ทุก 5 นาทีในเวลาทำการ: ดึง visit วันนี้เก็บ cache (ตรวจค่าลับกับ Vault)
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: ok } = await admin.rpc("verify_cron_secret", { p_secret: cronSecret });
    if (ok !== true) return json({ error: "unauthorized" }, 401);
    const today = bangkokToday();
    try {
      const visits = await withTimeout(visitsOn(today), 30_000);
      await saveVisits(admin, visits);
      // ยาที่ได้ของวันนี้ในรอบเดียวกัน (ประวัติในกล่องข้อมูลลูกค้า) · พลาดไม่ทำให้ visit ล้ม
      const drugs = await withTimeout(drugsBetween(today, today), 30_000).then((d) => saveDrugs(admin, d))
        .catch((e) => { console.error("drug refresh failed", e instanceof Error ? e.message : e); return null; });
      await pruneVisits(admin, today);
      return json({ date: today, cached: visits.length, drugs });
    } catch (e) {
      console.error("visit refresh failed", e instanceof Error ? e.message : e);
      return json({ error: "ดึง visit ไม่สำเร็จ" }, 502);
    }
  }
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

  const b = await req.json().catch(() => ({})) as { action?: string; q?: string; hn?: string; simulate_down?: boolean; from?: string; to?: string };
  // ทดสอบกรณี iService ล่ม (เฉพาะ server ของ DocDesk)
  const live = <T>(p: () => Promise<T>): Promise<T> =>
    isServer && b.simulate_down ? Promise.reject(new Error("simulated iService down")) : withTimeout(p(), LIVE_TIMEOUT_MS);
  try {
    // ตรวจการเชื่อมต่อ: เรียกได้เฉพาะ server ของ DocDesk (ผ่าน /api/appointments/iservice-check ของแอดมิน)
    if (b.action === "diagnose") {
      if (!isServer) return json({ error: "forbidden" }, 403);
      return json(await diagnose(bangkokToday(), (b.q ?? "").trim().slice(0, 30)));
    }
    // เติมย้อนหลัง (server เท่านั้น): การวินิจฉัยของ visit ที่อยู่ใน cache (ไม่เขียนทับ) + ยาที่ได้ ทีละไม่เกิน 31 วัน
    if (b.action === "backfill") {
      if (!isServer) return json({ error: "forbidden" }, 403);
      const today = bangkokToday();
      const floor = new Date(Date.parse(`${today}T12:00:00Z`) - VISIT_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
      const ok = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
      if (!ok(b.from) || !ok(b.to) || b.from > b.to) return json({ error: "from/to = YYYY-MM-DD" }, 400);
      const from = b.from < floor ? floor : b.from;
      const to = b.to > today ? today : b.to;
      // ครั้งละก้อนเดียว (≤ 31 วัน) ให้อยู่ในเวลาของ edge function · next = วันเริ่มของก้อนถัดไป
      const chunks = dateChunks(from, to, 31);
      const result = { from, to: chunks[0]?.to ?? to, next: chunks[1]?.from ?? null, visits: 0, diagnosisFilled: 0, drugs: 0 };
      for (const c of chunks.slice(0, 1)) {
        const visits = await visitsBetween(c.from, c.to);
        result.visits += visits.length;
        result.diagnosisFilled += await fillMissingDiagnosis(admin, visits);
        result.drugs += await saveDrugs(admin, await drugsBetween(c.from, c.to));
      }
      return json(result);
    }
    // ล่าสุดก่อน
    const sortVisits = <T extends { time: string; seq: number }>(v: T[]) => v.sort((a, z) => z.time.localeCompare(a.time) || z.seq - a.seq);
    if (b.action === "visits") {
      const today = bangkokToday();
      try {
        const visits = await live(() => visitsOn(today));
        await saveVisits(admin, visits);
        return json({ visits: sortVisits(visits) });
      } catch (e) {
        console.error("iservice visits failed, using cache", e instanceof Error ? e.message : e);
        const cached = await cachedVisits(admin, today);
        if (!cached.at) throw e;
        return json({ visits: sortVisits(cached.visits), cached: true, cachedAt: cached.at });
      }
    }
    // ค้นหา: HN/เบอร์ → list_patient ของ iService, ชื่อ → patients ของ DocDesk (iService ค้นชื่อไม่ได้)
    if (b.action === "patients") {
      const c = classifySearch(b.q ?? "");
      if (!c) return json({ patients: [], kind: null });
      if (c.kind === "name") {
        return json({ patients: await enrich(admin, await docdeskPatients(admin, { name: c.value })), kind: c.kind, source: "docdesk" });
      }
      const queries = c.kind === "hn" ? [{ hn: c.value }] : c.kind === "phone" ? [{ phone: c.value }] : [{ hn: c.value }, { phone: c.value }];
      try {
        const found = (await live(() => Promise.all(queries.map((q) => listPatient(q))))).flat();
        const unique = [...new Map(found.map((p) => [p.hn, p])).values()];
        return json({ patients: await enrich(admin, unique), kind: c.kind, source: "iservice" });
      } catch (e) {
        console.error("list_patient failed, using DocDesk patients", e instanceof Error ? e.message : e);
        const local = (await Promise.all(queries.map((q) => docdeskPatients(admin, q)))).flat();
        return json({ patients: await enrich(admin, [...new Map(local.map((p) => [p.hn, p])).values()]), kind: c.kind, source: "docdesk", cached: true, cachedAt: null });
      }
    }
    // เลือกคนไข้แล้ว: ชื่อ + เบอร์จาก list_patient ถ้าล่มใช้เบอร์ใน patients ของ DocDesk
    if (b.action === "patient") {
      const hn = (b.hn ?? "").trim().slice(0, 30);
      if (!hn) return json({ patient: null });
      try {
        const found = (await live(() => listPatient({ hn }))).find((p) => padHn(p.hn) === padHn(hn)) ?? null;
        return json({ patient: found });
      } catch (e) {
        console.error("list_patient failed, using DocDesk patients", e instanceof Error ? e.message : e);
        const [local] = await docdeskPatients(admin, { hn });
        return json({ patient: local ?? null, cached: true, cachedAt: null });
      }
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    // ไม่ส่งรายละเอียดซึ่งอาจมี URL หรือ token ออกไป
    console.error("iservice failed", b.action, e instanceof Error ? e.message : e);
    return json({ error: "เชื่อมต่อ iService ไม่สำเร็จ" }, 502);
  }
});
