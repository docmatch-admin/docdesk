import { openai } from "./ai";
import { modelFor } from "./ai-models";
import { debugPageToken } from "./channels/meta";
import { HEALTH_LABEL, type HealthRow } from "./health-rules";
import { supabaseAdmin } from "./supabase/admin";

const LINE_API = "https://api.line.me/v2/bot";
const CRON_MAX_AGE_MS = 5 * 60 * 1000;
const ERROR_WINDOW_MS = 60 * 60 * 1000;
const ALERT_INTERVAL_MS = 60 * 60 * 1000;
const ERROR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;

/** บันทึก error โดยห้าม throw เพราะถูกเรียกระหว่างจัดการ error อื่น */
export async function logSystemError(source: string, error: unknown) {
  try {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await supabaseAdmin().from("system_errors").insert({ source, message });
  } catch (e) {
    console.error("log system error failed", e);
  }
}

export async function touchHeartbeat(name: string, at = new Date()) {
  await supabaseAdmin().from("system_heartbeat").upsert({ name, at: at.toISOString() }, { onConflict: "name" });
}

type CheckResult = { ok: boolean; detail: string };

async function guarded(check: () => Promise<CheckResult>): Promise<CheckResult> {
  try {
    return await check();
  } catch (e) {
    return { ok: false, detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

function lineHeaders() {
  return { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` };
}

async function checkSupabase(): Promise<CheckResult> {
  const { error } = await supabaseAdmin().from("settings").select("key").limit(1);
  return error ? { ok: false, detail: error.message } : { ok: true, detail: "เชื่อมต่อได้" };
}

/** เรียกตรง ไม่ผ่าน embed() เพื่อไม่ให้ปนกับสถิติการใช้ AI ของแชท */
async function checkOpenAi(): Promise<CheckResult> {
  await openai().embeddings.create({ model: await modelFor("embed"), input: "ping" }, { timeout: CHECK_TIMEOUT_MS, maxRetries: 0 });
  return { ok: true, detail: "เรียกได้" };
}

async function checkLineToken(): Promise<CheckResult> {
  const res = await fetch(`${LINE_API}/info`, { headers: lineHeaders(), signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  return res.ok ? { ok: true, detail: "ใช้ได้" } : { ok: false, detail: `LINE ตอบ ${res.status}` };
}

async function checkLineWebhook(origin: string): Promise<CheckResult> {
  const res = await fetch(`${LINE_API}/channel/webhook/endpoint`, { headers: lineHeaders(), signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
  if (!res.ok) return { ok: false, detail: `LINE ตอบ ${res.status}` };
  const { endpoint, active } = (await res.json()) as { endpoint?: string; active?: boolean };
  const expected = `${origin}/api/webhooks/line`;
  if (endpoint !== expected) return { ok: false, detail: `ชี้ไปที่ ${endpoint ?? "(ไม่มี)"}` };
  if (!active) return { ok: false, detail: "ปิด Use webhook อยู่" };
  return { ok: true, detail: "ถูกต้อง" };
}

async function checkCron(now: number): Promise<CheckResult> {
  const { data } = await supabaseAdmin().from("system_heartbeat").select("at").eq("name", "cron_fallback").maybeSingle();
  if (!data) return { ok: false, detail: "ยังไม่เคยรัน" };
  const age = now - Date.parse(data.at as string);
  const minutes = Math.round(age / 60_000);
  return age <= CRON_MAX_AGE_MS ? { ok: true, detail: `${minutes} นาทีก่อน` } : { ok: false, detail: `รันล่าสุด ${minutes} นาทีก่อน` };
}

async function checkWebhookErrors(now: number): Promise<CheckResult> {
  const { data, count } = await supabaseAdmin().from("system_errors").select("message", { count: "exact" })
    .like("source", "webhook%").gte("created_at", new Date(now - ERROR_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const n = count ?? data?.length ?? 0;
  return n === 0 ? { ok: true, detail: "ไม่มี" } : { ok: false, detail: `${n} รายการ ล่าสุด: ${(data?.[0]?.message as string ?? "").slice(0, 120)}` };
}

/** ส่งอีเมลเมื่อตั้ง RESEND_API_KEY และ ALERT_EMAIL แล้ว ถ้ายังไม่ตั้งข้ามเงียบๆ แถบแดงยังทำงาน */
async function sendAlertEmail(problems: string[]): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!key || !to) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM || "DocDesk <onboarding@resend.dev>",
      to,
      subject: "DocDesk: ระบบผิดปกติ",
      text: `รายการที่ผิดปกติ\n${problems.map((p) => `- ${p}`).join("\n")}`,
    }),
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ส่งอีเมลไม่สำเร็จ ${res.status}`);
  return true;
}

/** แจ้งซ้ำไม่เกินชั่วโมงละครั้ง */
export async function maybeAlert(problems: string[], now = Date.now()): Promise<boolean> {
  if (!problems.length) return false;
  const db = supabaseAdmin();
  const { data } = await db.from("system_heartbeat").select("at").eq("name", "health_alert").maybeSingle();
  if (data && now - Date.parse(data.at as string) < ALERT_INTERVAL_MS) return false;
  try {
    if (!(await sendAlertEmail(problems))) return false;
  } catch (e) {
    console.error("health alert failed", e);
    return false;
  }
  await touchHeartbeat("health_alert", new Date(now));
  return true;
}

export async function runHealthChecks(origin: string, now = Date.now()): Promise<HealthRow[]> {
  const checks: [string, () => Promise<CheckResult>][] = [
    ["supabase", checkSupabase],
    ["openai", checkOpenAi],
    ["line_token", checkLineToken],
    ["line_webhook", () => checkLineWebhook(origin)],
    ["cron_fallback", () => checkCron(now)],
    ["webhook_errors", () => checkWebhookErrors(now)],
    // ยังไม่ได้เชื่อม Facebook ไม่ต้องขึ้นแดง
    ...(process.env.META_PAGE_ACCESS_TOKEN ? [["meta_token", debugPageToken] as [string, () => Promise<CheckResult>]] : []),
  ];
  const checked_at = new Date(now).toISOString();
  const rows: HealthRow[] = await Promise.all(checks.map(async ([check_name, run]) => ({ check_name, checked_at, ...(await guarded(run)) })));

  const db = supabaseAdmin();
  await Promise.all(rows.map((row) => db.from("system_health").upsert(row, { onConflict: "check_name" })));
  await db.from("system_errors").delete().lt("created_at", new Date(now - ERROR_RETENTION_MS).toISOString());
  await maybeAlert(rows.filter((r) => !r.ok).map((r) => HEALTH_LABEL[r.check_name] ?? r.check_name), now);
  return rows;
}
