// ทดสอบการตรวจสุขภาพระบบ: npm test
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { openaiState } = await import(fake("ai"));
const { resetDb, state } = await import(fake("admin"));
const { logSystemError, maybeAlert, runHealthChecks, touchHeartbeat } = await import("../src/lib/health.ts");
const { healthProblems, HEALTH_STALE_MS } = await import("../src/lib/health-rules.ts");

const ORIGIN = "https://app.test";
const NOW = Date.parse("2026-11-02T03:00:00Z");
const realFetch = globalThis.fetch;
let line;

beforeEach(() => {
  resetDb({ system_errors: [], system_health: [], system_heartbeat: [{ name: "cron_fallback", at: new Date(NOW - 60_000).toISOString() }] });
  openaiState.fail = null;
  process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
  delete process.env.RESEND_API_KEY;
  delete process.env.ALERT_EMAIL;
  line = { info: 200, webhookStatus: 200, webhook: { endpoint: `${ORIGIN}/api/webhooks/line`, active: true } };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/info")) return new Response("{}", { status: line.info });
    if (String(url).endsWith("/webhook/endpoint")) return new Response(JSON.stringify(line.webhook), { status: line.webhookStatus });
    throw new Error(`ไม่คาดว่าจะเรียก ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const run = async () => Object.fromEntries((await runHealthChecks(ORIGIN, NOW)).map((r) => [r.check_name, r]));

test("ปกติครบ: ทุกข้อผ่าน และบันทึกผลลงตาราง", async () => {
  const r = await run();
  assert.equal(Object.keys(r).length, 6);
  assert.ok(Object.values(r).every((c) => c.ok), JSON.stringify(r));
  assert.equal(state.tables.system_health.length, 6);
});

test("รันซ้ำ: อัปเดตแถวเดิม ไม่เพิ่มแถว", async () => {
  await run();
  await run();
  assert.equal(state.tables.system_health.length, 6);
});

test("OpenAI ล้มเหลว: แดงเฉพาะข้อนั้น", async () => {
  openaiState.fail = "401 invalid key";
  const r = await run();
  assert.equal(r.openai.ok, false);
  assert.match(r.openai.detail, /401/);
  assert.equal(r.supabase.ok, true);
});

test("LINE token ใช้ไม่ได้", async () => {
  line.info = 401;
  assert.equal((await run()).line_token.ok, false);
});

test("LINE webhook ชี้ไปที่อื่น", async () => {
  line.webhook.endpoint = "https://other.example/hook";
  const r = await run();
  assert.equal(r.line_webhook.ok, false);
  assert.match(r.line_webhook.detail, /other\.example/);
});

test("LINE ปิด Use webhook", async () => {
  line.webhook.active = false;
  assert.match((await run()).line_webhook.detail, /Use webhook/);
});

test("เรียก LINE ไม่ได้: แดง แต่ข้ออื่นยังตรวจต่อ", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  const r = await run();
  assert.equal(r.line_token.ok, false);
  assert.equal(r.supabase.ok, true);
});

test("cron เกิน 5 นาที: แดง และครบ 5 นาทีพอดีผ่าน", async () => {
  state.tables.system_heartbeat[0].at = new Date(NOW - 5 * 60_000).toISOString();
  assert.equal((await run()).cron_fallback.ok, true);
  state.tables.system_heartbeat[0].at = new Date(NOW - 5 * 60_000 - 1000).toISOString();
  assert.equal((await run()).cron_fallback.ok, false);
});

test("cron ไม่เคยรัน: แดง", async () => {
  state.tables.system_heartbeat = [];
  assert.match((await run()).cron_fallback.detail, /ยังไม่เคยรัน/);
});

test("error ใน webhook ภายใน 1 ชั่วโมง: แดง, เก่ากว่านั้นหรือ source อื่นไม่นับ", async () => {
  state.tables.system_errors = [
    { source: "webhook:line", message: "เก่า", created_at: new Date(NOW - 2 * 3_600_000).toISOString() },
    { source: "other", message: "อื่น", created_at: new Date(NOW - 60_000).toISOString() },
  ];
  assert.equal((await run()).webhook_errors.ok, true);
  state.tables.system_errors.push({ source: "webhook:line", message: "พัง", created_at: new Date(NOW - 60_000).toISOString() });
  const r = await run();
  assert.equal(r.webhook_errors.ok, false);
  assert.match(r.webhook_errors.detail, /1 รายการ/);
});

test("error เก่ากว่า 30 วันถูกลบ", async () => {
  state.tables.system_errors = [{ source: "webhook:line", message: "x", created_at: new Date(NOW - 31 * 86_400_000).toISOString() }];
  await run();
  assert.equal(state.tables.system_errors.length, 0);
});

test("บันทึก error: เก็บข้อความ ตัดความยาว และห้าม throw", async () => {
  await logSystemError("webhook:line", new Error("x".repeat(900)));
  assert.equal(state.tables.system_errors[0].message.length, 500);
  state.tables.system_errors = null;
  await logSystemError("webhook:line", "ล้มเหลว");
});

// ---- แจ้งเตือน ----
function emailSetup() {
  process.env.RESEND_API_KEY = "key";
  process.env.ALERT_EMAIL = "admin@example.test";
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}", { status: 200 }); };
  return sent;
}

test("ยังไม่ตั้งอีเมล: ไม่ส่ง ไม่พัง และไม่บันทึกว่าแจ้งแล้ว", async () => {
  assert.equal(await maybeAlert(["ฐานข้อมูล"], NOW), false);
  assert.equal(state.tables.system_heartbeat.some((h) => h.name === "health_alert"), false);
});

test("ตั้งอีเมลแล้ว: แจ้ง และไม่แจ้งซ้ำภายใน 1 ชั่วโมง", async () => {
  const sent = emailSetup();
  assert.equal(await maybeAlert(["OpenAI"], NOW), true);
  assert.match(sent[0].body.text, /OpenAI/);
  assert.equal(await maybeAlert(["OpenAI"], NOW + 59 * 60_000), false);
  assert.equal(await maybeAlert(["OpenAI"], NOW + 60 * 60_000), true);
  assert.equal(sent.length, 2);
});

test("ไม่มีปัญหา: ไม่แจ้ง", async () => {
  const sent = emailSetup();
  assert.equal(await maybeAlert([], NOW), false);
  assert.equal(sent.length, 0);
});

test("ส่งอีเมลไม่สำเร็จ: ไม่พัง และลองใหม่รอบหน้า", async (t) => {
  t.mock.method(console, "error", () => {});
  process.env.RESEND_API_KEY = "key";
  process.env.ALERT_EMAIL = "admin@example.test";
  globalThis.fetch = async () => new Response("{}", { status: 500 });
  assert.equal(await maybeAlert(["OpenAI"], NOW), false);
  assert.equal(state.tables.system_heartbeat.some((h) => h.name === "health_alert"), false);
});

test("บันทึก heartbeat ทับแถวเดิม", async () => {
  await touchHeartbeat("cron_fallback", new Date(NOW));
  assert.equal(state.tables.system_heartbeat.filter((h) => h.name === "cron_fallback").length, 1);
  assert.equal(state.tables.system_heartbeat[0].at, new Date(NOW).toISOString());
});

// ---- แถบแดง ----
const row = (ok, check_name = "openai", at = NOW) => ({ check_name, ok, detail: "", checked_at: new Date(at).toISOString() });

test("แถบแดง: ปกติไม่ขึ้น ผิดปกติบอกชื่อข้อ", () => {
  assert.deepEqual(healthProblems([row(true)], NOW), []);
  assert.deepEqual(healthProblems([row(false), row(true, "supabase")], NOW), ["OpenAI"]);
  assert.deepEqual(healthProblems([], NOW), [], "ยังไม่เคยตรวจ ยังไม่เตือน");
});

test("แถบแดง: ตัวตรวจไม่ทำงานเกิน 15 นาที ต้องเตือน แม้ผลเดิมเขียวหมด", () => {
  assert.deepEqual(healthProblems([row(true)], NOW + HEALTH_STALE_MS), []);
  assert.deepEqual(healthProblems([row(true)], NOW + HEALTH_STALE_MS + 1), ["ตัวตรวจสุขภาพระบบไม่ได้ทำงาน"]);
});
