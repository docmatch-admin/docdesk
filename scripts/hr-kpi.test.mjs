// ส่งคะแนนตอบแชทของเจ้าหน้าที่เข้า HR ทุกวัน (metric chat_reply): npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const rules = await import("../src/lib/hr-kpi-rules.ts");
const { loadChatKpi, sendChatKpi } = await import("../src/lib/hr-kpi.ts");
const { fetchHrEmployees, hrFullName, hrSyncEnabled } = await import("../src/lib/hr-sync.ts");
const cronRoute = await import("../src/app/api/cron/hr-kpi/route.ts");

const realFetch = globalThis.fetch;
const KPI_URL = "https://hr.test/functions/v1/kpi-ingest";
const DATE = "2026-11-11";
// 2026-11-11 เวลาไทย = 2026-11-10T17:00Z ถึง 2026-11-11T17:00Z
const at = (bkk) => new Date(Date.parse(`${DATE}T${bkk}:00+07:00`)).toISOString();

const A = "staff-a", B = "staff-b", C = "staff-c", D = "staff-d";
const msg = (id, conv, sender_type, sender_id, created_at, extra = {}) =>
  ({ id, conversation_id: conv, direction: sender_type === "customer" ? "in" : "out", sender_type, sender_id, body: "x", created_at, ...extra });

beforeEach(() => {
  resetDb({
    staff: [
      { id: A, role: "agent", active: true, display_name: "เอ", hr_employee_id: "hr-a" },
      { id: B, role: "agent", active: true, display_name: "บี", hr_employee_id: null },
      { id: C, role: "agent", active: true, display_name: "ซี", hr_employee_id: null },
      { id: D, role: "agent", active: true, display_name: "ดี", hr_employee_id: null },
    ],
    messages: [
      msg("m1", "c1", "customer", null, at("08:59")),
      msg("m2", "c1", "staff", A, at("09:00")),
      msg("m3", "c1", "staff", A, at("09:05")),
      msg("m4", "c2", "staff", A, at("10:00")),
      msg("m5", "c3", "staff", B, at("23:59")),
      // ไม่นับ: AI ตอบเอง · ข้อความระบบ · ประวัติที่นำเข้า · คนละวัน (ก่อนเที่ยงคืนไทย / หลังเที่ยงคืนไทย)
      msg("m6", "c1", "ai", null, at("09:01")),
      msg("m7", "c1", "system", null, at("09:02")),
      msg("m8", "c4", "staff", B, at("11:00"), { imported: true }),
      msg("m9", "c5", "staff", B, "2026-11-10T16:59:59.000Z"),
      msg("m10", "c5", "staff", B, "2026-11-11T17:00:00.000Z"),
      // ส่งได้แต่ไม่มีอีเมลและไม่ได้จับคู่ HR → ข้าม
      msg("m11", "c6", "staff", D, at("12:00")),
    ],
    response_events: [
      { replied_by: A, response_seconds: 60, replied_at: at("09:00") },
      { replied_by: A, response_seconds: 131, replied_at: at("10:00") },
      { replied_by: B, response_seconds: 999, replied_at: "2026-11-10T16:00:00.000Z" },
    ],
  });
  state.authUsers = [
    { id: A, email: "a@staff.docdesk.local" },
    { id: B, email: " Bee@Clinic.TEST " },
    { id: C, email: "c@clinic.test" },
  ];
  process.env.HR_KPI_URL = KPI_URL;
  process.env.HR_KPI_KEY = "hrk_test";
  process.env.CRON_SECRET = "cron-s3cret";
  delete process.env.HR_SYNC_URL;
  delete process.env.HR_SYNC_SECRET;
});
afterEach(() => { globalThis.fetch = realFetch; });

const employees = [
  { id: "hr-a", employee_code: "E001", title: null, first_name: null, last_name: null, full_name: "สมหญิง ใจดี", nickname: "เอ", email: "", position: "พยาบาล", employment_status: "active" },
];
/** HR ปลอม: GET ?action=employees คืนรายชื่อ · POST คืน unmatched */
function fakeHr({ postStatus = 200, unmatched = [], employeesStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if ((init.method ?? "GET") === "GET") return new Response(JSON.stringify({ employees }), { status: employeesStatus });
    return new Response(JSON.stringify({ ok: postStatus === 200, unmatched }), { status: postStatus });
  };
  return calls;
}
const cron = (query = "", auth = "Bearer cron-s3cret") =>
  cronRoute.GET(new Request(`https://app.test/api/cron/hr-kpi${query}`, { headers: auth ? { authorization: auth } : {} }));

test("วันที่: เมื่อวานตามเวลาไทย และช่วงเวลาของวัน", () => {
  // 01:00 น. ไทยวันที่ 12 (18:00 UTC วันที่ 11) → ส่งของวันที่ 11
  assert.equal(rules.bangkokYesterday(Date.parse("2026-11-11T18:00:00Z")), "2026-11-11");
  // 06:59 น. ไทยวันที่ 1 ม.ค. → 31 ธ.ค. ปีก่อน
  assert.equal(rules.bangkokYesterday(Date.parse("2026-12-31T23:59:00Z")), "2026-12-31");
  assert.equal(rules.bangkokYesterday(Date.parse("2027-01-01T00:30:00Z")), "2026-12-31");
  assert.deepEqual(rules.bangkokDayRange(DATE), { from: "2026-11-10T17:00:00.000Z", to: "2026-11-11T17:00:00.000Z" });
  assert.equal(rules.isKpiDate("2026-11-11"), true);
  for (const bad of ["2026-02-30", "2026-1-1", "yesterday", "", null]) assert.equal(rules.isKpiDate(bad), false, String(bad));
});

test("สรุปรายเจ้าหน้าที่: chats · replies · เวลาตอบแรกเฉลี่ย · ไม่นับ AI/ระบบ/นำเข้า/คนละวัน", async () => {
  fakeHr();
  const records = await loadChatKpi(DATE);
  assert.deepEqual(records, [
    { date: DATE, email: "bee@clinic.test", chats: 1, replies: 1 },
    { date: DATE, employee_code: "E001", chats: 2, replies: 3, avg_first_response_sec: 96 },
  ]);
});

test("ไม่มีระบบให้คะแนนจากลูกค้า: ไม่ส่ง rating_avg", async () => {
  fakeHr();
  for (const r of await loadChatKpi(DATE)) assert.equal("rating_avg" in r, false);
});

test("จับคู่ HR ไว้แต่อ่านรายชื่อ HR ไม่ได้: ใช้อีเมลแทน ไม่ล้ม", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeHr({ employeesStatus: 500 });
  const records = await loadChatKpi(DATE);
  assert.equal(records.find((r) => r.email === "a@staff.docdesk.local")?.replies, 3);
  assert.equal(records.some((r) => r.employee_code), false);
});

test("ส่งเข้า HR: POST พร้อม x-api-key และ body ตามรูปแบบ · log unmatched", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const calls = fakeHr({ unmatched: [{ email: "bee@clinic.test" }] });
  const result = await sendChatKpi(DATE);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.url, KPI_URL);
  assert.equal(post.headers["x-api-key"], "hrk_test");
  assert.equal(post.body.metric, "chat_reply");
  assert.equal(post.body.records.length, 2);
  assert.deepEqual(result, { date: DATE, sent: 2, unmatched: [{ email: "bee@clinic.test" }] });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /หาเจ้าหน้าที่ไม่เจอ 1 คน/);
});

test("วันที่ไม่มีใครตอบ: ไม่ส่ง · HR ล่ม: คืน error", async () => {
  let calls = fakeHr();
  assert.deepEqual(await sendChatKpi("2026-11-01"), { date: "2026-11-01", sent: 0, unmatched: [] });
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  calls = fakeHr({ postStatus: 401 });
  const r = await sendChatKpi(DATE);
  assert.equal(r.sent, 0);
  assert.match(r.error, /401/);
});

test("cron: ต้องมี CRON_SECRET · ค่าเริ่มต้นคือเมื่อวาน · ส่งย้อนหลังด้วย ?date=", async () => {
  const calls = fakeHr();
  assert.equal((await cron("", null)).status, 401);
  assert.equal((await cron("", "Bearer wrong")).status, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await cron("", "Bearer ")).status, 401, "ไม่ได้ตั้ง CRON_SECRET ห้ามเปิดโล่ง");
  process.env.CRON_SECRET = "cron-s3cret";
  assert.equal((await cron("?date=2026-13-01")).status, 400);

  const res = await cron(`?date=${DATE}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sent, 2);
  assert.equal(calls.filter((c) => c.method === "POST")[0].body.records[0].date, DATE);

  const dflt = await (await cron()).json();
  assert.equal(dflt.date, rules.bangkokYesterday());
  assert.ok(state.tables.system_heartbeat.some((h) => h.name === "cron_hr_kpi"));
});

test("cron: ยังไม่ตั้ง env HR ตอบ 502 และบันทึก error", async () => {
  delete process.env.HR_KPI_KEY;
  const res = await cron(`?date=${DATE}`);
  assert.equal(res.status, 502);
  assert.ok(state.tables.system_errors.some((e) => e.source === "cron:hr-kpi"));
});

test("Vercel Cron: ทุกวัน 18:00 UTC (01:00 น. ไทย) · คีย์ไม่อยู่ในโค้ด", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.deepEqual(vercel.crons, [{ path: "/api/cron/hr-kpi", schedule: "0 18 * * *" }]);
  for (const f of ["src/lib/hr-kpi.ts", "src/lib/hr-kpi-rules.ts", "src/lib/hr-sync.ts", "src/app/api/cron/hr-kpi/route.ts", ".env.example", "vercel.json"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /hrk_[0-9a-f]{8,}|aojzpxqufddgpehglllr/, f);
  }
});

test("ดึงชื่อจาก HR: ใช้ HR_KPI_URL?action=employees ได้ เมื่อไม่ได้ตั้ง HR_SYNC_*", async () => {
  assert.equal(hrSyncEnabled(), true);
  const calls = fakeHr();
  const list = await fetchHrEmployees();
  assert.equal(list[0].employee_code, "E001");
  assert.equal(calls[0].url, `${KPI_URL}?action=employees`);
  assert.equal(calls[0].headers["x-api-key"], "hrk_test");
  assert.equal(hrFullName(list[0]), "สมหญิง ใจดี", "ไม่มีคำนำหน้า/ชื่อ/สกุลแยก ใช้ full_name");
  // ตั้ง HR_SYNC_* ไว้ ยังใช้ของเดิม
  process.env.HR_SYNC_URL = "https://hr.test/legacy";
  process.env.HR_SYNC_SECRET = "s";
  await fetchHrEmployees();
  assert.equal(calls.at(-1).url, "https://hr.test/legacy");
  delete process.env.HR_KPI_URL;
  delete process.env.HR_SYNC_URL;
  assert.equal(hrSyncEnabled(), false);
});
