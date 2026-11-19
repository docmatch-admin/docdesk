// ชื่อคนไข้จากระบบใบเสร็จ → patients (ค้นด้วยชื่อตอนทำนัด): npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const { importReceiptPatients, planReceiptImport, receiptHn, RECEIPT_SOURCE } = await import("../src/lib/receipt-patients.ts");
const { nameSearchTerms } = await import("../supabase/functions/_shared/patient-name.ts");
const route = await import("../src/app/api/cron/patient-names/route.ts");

process.env.CRON_SECRET = "cron-test";
process.env.RCPT_PATIENT_TOKEN = "rcpt-token";

let rpcCalls = [];
let rpcRows = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/rest/v1/rpc/docdesk_patient_names")) {
    rpcCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(rpcRows), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, init);
};

beforeEach(() => {
  rpcCalls = [];
  rpcRows = [];
  resetDb({
    staff: [{ id: "adm", role: "admin", active: true, display_name: "แอดมิน", must_change_password: false }, { id: "ag", role: "agent", active: true, display_name: "เอเจนต์", must_change_password: false }],
    patients: [
      { hn: "000000001", full_name: null, name_source: null },                         // ยังไม่มีชื่อ → เติม
      { hn: "000000002", full_name: "นายเก่า จากใบเสร็จ", name_source: "receipt" },     // มาจากใบเสร็จเดิม → อัปเดต
      { hn: "000000003", full_name: "นายสมชาย ใจดี", name_source: null },               // จาก iService / เจ้าหน้าที่ → ห้ามทับ
    ],
  });
});

test("receiptHn: ตัวเลขเติม 0 ให้ครบ 9 หลัก · ไม่ใช่ตัวเลข = ข้าม", () => {
  assert.equal(receiptHn("000004141"), "000004141");
  assert.equal(receiptHn("4141"), "000004141");
  assert.equal(receiptHn(" 4141 "), "000004141");
  assert.equal(receiptHn("HN4141"), null);
  assert.equal(receiptHn(""), null);
});

test("แผนนำเข้า: ใหม่ = เพิ่ม · ชื่อว่าง/มาจากใบเสร็จเดิม = อัปเดต · ชื่อจากแหล่งอื่น = ไม่ทับ · ไม่เปลี่ยน = ข้าม", () => {
  const existing = new Map([
    ["000000001", { hn: "000000001", full_name: "", name_source: null }],
    ["000000002", { hn: "000000002", full_name: "เก่า", name_source: "receipt" }],
    ["000000003", { hn: "000000003", full_name: "จาก iService", name_source: null }],
    ["000000004", { hn: "000000004", full_name: "เหมือนเดิม", name_source: "receipt" }],
  ]);
  const p = planReceiptImport([
    { hn: "000000001", full_name: "ชื่อ ใหม่" },
    { hn: "000000002", full_name: "ชื่อ  ใหม่กว่า " },
    { hn: "000000003", full_name: "ห้ามทับ" },
    { hn: "000000004", full_name: "เหมือนเดิม" },
    { hn: "000000005", full_name: "คนใหม่" },
    { hn: "abc", full_name: "x" },
    { hn: "000000006", full_name: "  " },
  ], existing);
  assert.deepEqual(p.rows.map((r) => [r.hn, r.full_name]), [["000000001", "ชื่อ ใหม่"], ["000000002", "ชื่อ ใหม่กว่า"], ["000000005", "คนใหม่"]]);
  assert.deepEqual({ inserted: p.inserted, updated: p.updated, unchanged: p.unchanged, protected: p.protected, invalid: p.invalid },
    { inserted: 1, updated: 2, unchanged: 1, protected: 1, invalid: 2 });
});

test("นำเข้าจริง: เรียก RPC ด้วย publishable key + token · ไม่ทับชื่อจาก iService · ติดป้าย receipt", async () => {
  rpcRows = [
    { hn: "000000001", full_name: "นางสาวมานี มีนา", last_visit: "2026-11-01" },
    { hn: "000000002", full_name: "นายใหม่ จากใบเสร็จ", last_visit: "2026-11-02" },
    { hn: "000000003", full_name: "นายสมชาย ใจดีมาก", last_visit: "2026-11-03" },
    { hn: "000000099", full_name: "ด.ญ.ปิติ ยินดี", last_visit: "2026-11-04" },
  ];
  const r = await importReceiptPatients(null);
  assert.deepEqual(r, { since: null, fetched: 4, inserted: 1, updated: 2, unchanged: 0, protected: 1, invalid: 0 });
  assert.equal(rpcCalls.length, 1);
  assert.deepEqual(rpcCalls[0].body, { p_token: "rcpt-token", p_since: null });
  assert.match(rpcCalls[0].headers.apikey, /^sb_publishable_/);
  assert.equal(rpcCalls[0].headers.Authorization, `Bearer ${rpcCalls[0].headers.apikey}`);
  const byHn = Object.fromEntries(state.tables.patients.map((p) => [p.hn, p]));
  assert.equal(byHn["000000001"].full_name, "นางสาวมานี มีนา");
  assert.equal(byHn["000000001"].name_source, RECEIPT_SOURCE);
  assert.equal(byHn["000000002"].full_name, "นายใหม่ จากใบเสร็จ");
  assert.equal(byHn["000000003"].full_name, "นายสมชาย ใจดี", "ชื่อจาก iService/เจ้าหน้าที่ไม่ถูกทับ");
  assert.equal(byHn["000000099"].name_source, RECEIPT_SOURCE);
  assert.ok(!("cid" in byHn["000000099"]));
});

test("route: pg_cron (Bearer CRON_SECRET) ดึงย้อนหลัง 3 วัน · แอดมิน ?full=1 ดึงทั้งหมด · คนอื่นเรียกไม่ได้", async () => {
  rpcRows = [{ hn: "000000007", full_name: "นายทดสอบ ระบบ" }];
  const res = await route.POST(new Request("https://app.test/api/cron/patient-names?days=3", { method: "POST", headers: { authorization: "Bearer cron-test" } }));
  assert.equal(res.status, 200);
  assert.match(rpcCalls[0].body.p_since, /^\d{4}-\d{2}-\d{2}$/);

  state.currentUser = { id: "ag" };
  assert.equal((await route.POST(new Request("https://app.test/api/cron/patient-names?full=1", { method: "POST" }))).status, 403);
  state.currentUser = { id: "adm" };
  const full = await route.POST(new Request("https://app.test/api/cron/patient-names?full=1", { method: "POST" }));
  assert.equal(full.status, 200);
  assert.equal(rpcCalls.at(-1).body.p_since, null);

  delete process.env.RCPT_PATIENT_TOKEN;
  const noToken = await route.POST(new Request("https://app.test/api/cron/patient-names", { method: "POST", headers: { authorization: "Bearer cron-test" } }));
  assert.equal(noToken.status, 502);
  assert.match((await noToken.json()).error, /RCPT_PATIENT_TOKEN/);
  process.env.RCPT_PATIENT_TOKEN = "rcpt-token";
});

test("ค้นชื่อ: ตัดคำนำหน้า · ชื่ออย่างเดียว / นามสกุลอย่างเดียว / ทั้งคู่ (ทุกคำต้องเจอ)", () => {
  assert.deepEqual(nameSearchTerms("นายสมชาย"), ["สมชาย"]);
  assert.deepEqual(nameSearchTerms("นาย สมชาย ใจดี"), ["สมชาย", "ใจดี"]);
  assert.deepEqual(nameSearchTerms("นางสาวมานี"), ["มานี"]);
  assert.deepEqual(nameSearchTerms("ด.ญ.ปิติ"), ["ปิติ"]);
  assert.deepEqual(nameSearchTerms("คุณมานี มีนา"), ["มานี", "มีนา"]);
  assert.deepEqual(nameSearchTerms("ใจดี"), ["ใจดี"]);
  assert.deepEqual(nameSearchTerms("50%,(x)"), ["50"]);
  assert.deepEqual(nameSearchTerms("นาย"), []);
});

test("edge function ค้นชื่อด้วยทุกคำ (ilike ต่อคำ) · migration 064: ที่มาของชื่อ + trigger + index trigram · placeholder", () => {
  const fn = readFileSync("supabase/functions/iservice/index.ts", "utf8");
  assert.match(fn, /const terms = nameSearchTerms\(by\.name\);/);
  assert.match(fn, /for \(const t of terms\) q = q\.ilike\("full_name", `%\$\{t\}%`\);/);
  const sql = readFileSync("supabase/migrations/064_patient_name_search.sql", "utf8");
  assert.match(sql, /add column if not exists name_source text/);
  assert.match(sql, /new\.name_synced_at is not distinct from old\.name_synced_at/);
  assert.match(sql, /using gin \(full_name extensions\.gin_trgm_ops\)/);
  const cron = readFileSync("supabase/manual/064_patient_names_cron.sql", "utf8");
  assert.match(cron, /'0 19 \* \* \*'/, "02:00 เวลาไทย");
  assert.match(cron, /patient-names\?days=3/);
  const ui = readFileSync("src/app/(staff)/appointments/new-appointment.tsx", "utf8");
  assert.match(ui, /placeholder="HN, เบอร์โทร หรือชื่อ"/);
  assert.doesNotMatch(ui, /คนไข้ที่เคยนัด\)/);
});
