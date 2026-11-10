// นโยบายเก็บข้อมูล: งานที่เสร็จแล้ว / นัดที่ยกเลิก ซ่อนทันที ลบถาวรเมื่อพ้นระยะ: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const rules = await import("../src/lib/retention-rules.ts");
const store = await import("../src/lib/retention-store.ts");
const cronRoute = await import("../src/app/api/cron/retention/route.ts");
const monthlyRoute = await import("../src/app/api/reports/monthly/route.ts");

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const dateAgo = (d) => new Date(Date.parse(`${today}T00:00:00Z`) - d * DAY).toISOString().slice(0, 10);

const ADMIN = { id: "admin-1", email: "a@test" };
const A1 = "staff-a", A2 = "staff-b";

beforeEach(() => {
  resetDb({
    staff: [{ id: ADMIN.id, role: "admin", active: true, display_name: "แอดมิน" }, { id: A1, role: "agent", active: true, display_name: "เอ" }, { id: A2, role: "agent", active: true, display_name: "บี" }],
    conversations: [
      { id: "c31", status: "closed", closed_at: ago(31) },
      { id: "c29", status: "closed", closed_at: ago(29) },
      // เคยปิดนานแล้ว แต่เปิดใหม่ (closed_at เดิมยังอยู่) → ไม่ลบ
      { id: "cOpen", status: "open", closed_at: ago(60) },
    ],
    chat_tasks: [
      { id: "t31", conversation_id: "c31", text: "โทรยืนยัน", assignee_id: A1, done: true, done_at: ago(35) },
      { id: "t31b", conversation_id: "c31", text: "ส่งผลแล็บ", assignee_id: null, done: true, done_at: ago(33) },
      { id: "t31pending", conversation_id: "c31", text: "งานค้าง", assignee_id: A2, done: false, done_at: null },
      { id: "t29", conversation_id: "c29", text: "โทรยืนยัน", assignee_id: A1, done: true, done_at: ago(30) },
      { id: "tOpen", conversation_id: "cOpen", text: "เก่าแต่แชทเปิดอยู่", assignee_id: A2, done: true, done_at: ago(61) },
    ],
    chat_notes: [
      { id: "n1", conversation_id: "c31", task_id: "t31", body: "โทรแล้ว" },
      { id: "n2", conversation_id: "c31", task_id: null, body: "คอมเมนต์ของแชท (ไม่ใช่ของงาน)" },
      { id: "n3", conversation_id: "c29", task_id: "t29", body: "รอผล" },
    ],
    appointments: [
      { id: "x91", status: "cancelled", appoint_date: dateAgo(91), cancel_reason_code: "patient", purpose_text: "เจาะเลือด", series_id: "sGone" },
      { id: "x89", status: "cancelled", appoint_date: dateAgo(89), cancel_reason_code: "doctor", purpose_text: "ฟังผลแล็บ", series_id: null },
      { id: "x120", status: "cancelled", appoint_date: dateAgo(120), cancel_reason_code: null, purpose_text: "วัคซีน", series_id: "sKeep" },
      { id: "a200", status: "attended", appoint_date: dateAgo(200), purpose_text: "เจาะเลือด", series_id: "sKeep" },
      { id: "ns200", status: "no_show", appoint_date: dateAgo(200), purpose_text: "เจาะเลือด" },
      { id: "s200", status: "scheduled", appoint_date: dateAgo(200) },
      { id: "c200", status: "confirmed", appoint_date: dateAgo(200) },
      { id: "r200", status: "reschedule_requested", appoint_date: dateAgo(200) },
    ],
    appointment_events: [
      { id: "e1", appointment_id: "x91", kind: "cancelled" }, { id: "e2", appointment_id: "x91", kind: "created" },
      { id: "e3", appointment_id: "a200", kind: "attended" },
    ],
    appointment_series: [{ id: "sGone" }, { id: "sKeep" }],
    retention_stats: [],
    retention_runs: [],
    settings: [],
  });
  state.currentUser = ADMIN;
  process.env.CRON_SECRET = "cron-secret";
});

const ids = (rows) => (rows ?? []).map((r) => r.id).sort();

test("งานที่เสร็จแล้ว: แชทปิด 31 วันถูกลบ (พร้อมคอมเมนต์ในงาน) / 29 วันไม่ลบ / งานค้างไม่ลบ / แชทที่เปิดใหม่ไม่ลบ", async () => {
  const r = await store.runRetention();
  assert.equal(r.error, null);
  assert.deepEqual(ids(state.tables.chat_tasks), ["t29", "t31pending", "tOpen"]);
  assert.equal(r.tasks, 2);
  assert.equal(r.notes, 1);
  assert.deepEqual(ids(state.tables.chat_notes), ["n2", "n3"], "คอมเมนต์ของงานที่ลบหายไปด้วย คอมเมนต์ของแชทยังอยู่");
});

test("นัดยกเลิก: เลยวันนัด 91/120 วันถูกลบ (พร้อม log และชุดที่ว่าง) / 89 วันไม่ลบ / มาแล้ว ไม่มา รอนัด ยืนยัน ขอเลื่อน อายุ 200 วันไม่ลบ", async () => {
  const r = await store.runRetention();
  assert.deepEqual(ids(state.tables.appointments), ["a200", "c200", "ns200", "r200", "s200", "x89"]);
  assert.equal(r.appointments, 2);
  assert.equal(r.events, 2);
  assert.deepEqual(ids(state.tables.appointment_events), ["e3"]);
  assert.deepEqual(ids(state.tables.appointment_series), ["sKeep"], "ชุดที่ไม่เหลือนัดถูกลบ ชุดที่ยังมีนัดอยู่ไม่ลบ");
  assert.equal(r.series, 1);
});

test("ก่อนลบเก็บตัวเลขรายเดือน: รายงานเดือนเก่าได้ตัวเลขเดิมหลังลบ", async () => {
  const months = [...new Set([...state.tables.chat_tasks.filter((t) => t.done).map((t) => rules.monthOf(t.done_at)), ...state.tables.appointments.map((a) => rules.monthOf(a.appoint_date))])];
  const before = await Promise.all(months.map((m) => store.monthlySummary(m.slice(0, 7))));
  await store.runRetention();
  const after = await Promise.all(months.map((m) => store.monthlySummary(m.slice(0, 7))));
  assert.deepEqual(after, before);
  // สถิติที่เก็บไว้: งานแยกตามผู้รับ นัดยกเลิกแยกตามเหตุผลยกเลิกและเหตุผลนัด
  const s = state.tables.retention_stats;
  assert.ok(s.some((x) => x.metric === "tasks_done" && x.dim === "assignee" && x.key === A1 && x.count === 1));
  assert.ok(s.some((x) => x.metric === "tasks_done" && x.dim === "assignee" && x.key === "none" && x.count === 1));
  assert.ok(s.some((x) => x.metric === "appointments_cancelled" && x.dim === "cancel_reason" && x.key === "patient"));
  assert.ok(s.some((x) => x.metric === "appointments_cancelled" && x.dim === "purpose" && x.key === "วัคซีน"));
  // API รายงานรายเดือน (admin)
  const res = await monthlyRoute.GET(new Request(`https://app.test/api/reports/monthly?month=${rules.monthOf(dateAgo(91)).slice(0, 7)}`));
  assert.equal((await res.json()).cancelledByReason.patient >= 1, true);
  state.currentUser = { id: A1, email: "b@test" };
  assert.equal((await monthlyRoute.GET(new Request("https://app.test/api/reports/monthly?month=2026-01"))).status, 403);
});

test("รายงานทีม: งานที่เสร็จนับรวมตัวเลขที่เก็บไว้ (เดือนที่อยู่ในช่วงทั้งเดือน)", async () => {
  const monthStart = rules.monthOf(dateAgo(35));
  const fromIso = new Date(Date.parse(`${monthStart}T00:00:00Z`) - 7 * 3600_000).toISOString();
  const before = await store.tasksDoneByAssignee(fromIso);
  await store.runRetention();
  assert.deepEqual(await store.tasksDoneByAssignee(fromIso), before);
});

test("ลบเป็นชุดละ ≤ 500 แถว และบันทึกจำนวนที่ลบแต่ละรอบใน retention_runs", async () => {
  state.tables.conversations.push({ id: "cBulk", status: "closed", closed_at: ago(40) });
  for (let i = 0; i < 1201; i++) state.tables.chat_tasks.push({ id: `bulk${i}`, conversation_id: "cBulk", text: "x", assignee_id: A2, done: true, done_at: ago(41) });
  const calls = [];
  const orig = (await import(fake("admin"))).supabaseAdmin();
  const rpc = orig.rpc.bind(orig);
  orig.rpc = async (fn, args) => { calls.push([fn, args.p_limit]); return rpc(fn, args); };
  try {
    const r = await store.runRetention();
    assert.equal(r.tasks, 1203);
    assert.ok(calls.every(([, n]) => n <= 500), "ทุกชุด ≤ 500");
    assert.deepEqual(calls.filter(([f]) => f === "retention_delete_tasks").length, 3);
  } finally { orig.rpc = rpc; }
  const run = state.tables.retention_runs.at(-1);
  assert.equal(run.tasks_deleted, 1203);
  assert.equal(run.appointments_deleted, 2);
  assert.equal(run.error, null);
  assert.ok(run.finished_at);
  // ฟังก์ชันปฏิเสธชุดที่ใหญ่เกิน
  await assert.rejects(() => orig.rpc("retention_delete_tasks", { p_limit: 501 }));
});

test("ระยะเก็บแก้ได้ ต่ำสุด 7 วัน (ค่าแปลก ๆ ใช้ค่าเริ่มต้น)", async () => {
  assert.equal(rules.normalizeRetentionDays(3, 30), 7);
  assert.equal(rules.normalizeRetentionDays("45", 30), 45);
  assert.equal(rules.normalizeRetentionDays("abc", 90), 90);
  assert.equal(rules.normalizeRetentionDays(99999, 90), rules.RETENTION_MAX_DAYS);
  // ตั้ง 7 วัน: แชทที่ปิด 29 วันถูกลบด้วย
  state.tables.settings.push({ key: "retention_task_days", value: 3 });
  await store.runRetention();
  assert.ok(!state.tables.chat_tasks.some((t) => t.id === "t29"));
  assert.ok(state.tables.chat_tasks.some((t) => t.id === "t31pending"), "งานค้างไม่ถูกลบแม้ระยะสั้น");
});

test("cron: ต้องมีค่าลับ · migration: pg_cron 03:00 ไทย timeout 55000 · ลบเฉพาะ cancelled · FK ห้ามลบเปลี่ยนเป็น SET NULL", async () => {
  assert.equal((await cronRoute.GET(new Request("https://app.test/api/cron/retention"))).status, 401);
  const ok = await cronRoute.GET(new Request("https://app.test/api/cron/retention", { headers: { authorization: "Bearer cron-secret" } }));
  assert.equal(ok.status, 200);
  const sql = readFileSync("supabase/migrations/055_retention.sql", "utf8");
  assert.match(sql, /cron\.schedule\('docdesk-retention', '0 20 \* \* \*'/, "20:00 UTC = 03:00 เวลาไทย");
  assert.match(sql, /timeout_milliseconds := 55000/);
  assert.match(sql, /where status = 'cancelled' and appoint_date <= v_today - v_days/);
  assert.match(sql, /where t\.done and c\.status = 'closed' and c\.closed_at is not null/);
  assert.match(sql, /p_limit > 500 then raise exception/);
  assert.match(sql, /greatest\(7, coalesce/);
  assert.match(sql, /con\.confdeltype in \('a', 'r'\)/);
  assert.match(sql, /on delete set null/);
  assert.match(sql, /create policy admin_read on retention_runs for select to authenticated using \(is_admin\(\)\)/);
  // ทั้งสองฝั่งใช้เงื่อนไขเดียวกัน
  assert.ok(sql.includes("'retention_task_days', 30") && sql.includes("'retention_cancelled_appointment_days', 90"));
  assert.deepEqual(rules.RETENTION_DEFAULTS, { taskDays: 30, cancelledAppointmentDays: 90 });
});

test("ซ่อนทันที: กล่องขวาไม่แสดงงานที่เสร็จแล้วเมื่อแชทปิด · เปิดใหม่แสดงแบบย่อ · ตั้งค่าเฉพาะ admin", () => {
  const panel = readFileSync("src/app/(staff)/inbox/team-panel.tsx", "utf8");
  assert.match(panel, /\{!closed && finished\.length > 0 && \(/);
  assert.match(panel, /งานที่เสร็จแล้ว \(\{finished\.length\}\)/);
  assert.match(panel, /\{pending\.map\(renderTask\)\}/);
  assert.match(readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8"), /closed=\{selected\.status === "closed"\}/);
  const settings = readFileSync("src/app/(staff)/settings/settings-client.tsx", "utf8");
  assert.match(settings, /area="dataRetention"/);
  assert.match(settings, /min=\{RETENTION_MIN_DAYS\}/);
  assert.match(settings, /<RetentionRuns /);
});
