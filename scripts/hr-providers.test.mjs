// HR ดึงรายชื่อแพทย์จาก DocDesk (GET /api/hr/providers): npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const { hrProviderList, PROVIDER_RECENT_DAYS } = await import("../src/lib/hr-providers.ts");
const route = await import("../src/app/api/hr/providers/route.ts");

const NOW = Date.parse("2026-11-24T03:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const SECRET = "s".repeat(32);

beforeEach(() => {
  process.env.HR_CREDENTIAL_SECRET = SECRET;
  resetDb({ providers: [], system_errors: [] });
});

test("กรองแพทย์: active=true เสมอ · active=null เฉพาะภายใน 180 วัน · active=false ตัดทิ้ง · เรียงตามชื่อ", () => {
  const out = hrProviderList([
    { name: "นพ. ข", last_seen_at: daysAgo(400), active: true },
    { name: "พญ. ก", last_seen_at: daysAgo(10), active: null },
    { name: "นพ. ค", last_seen_at: daysAgo(PROVIDER_RECENT_DAYS + 1), active: null },
    { name: "นพ. ง", last_seen_at: daysAgo(1), active: false },
    { name: "Dr. A", last_seen_at: daysAgo(PROVIDER_RECENT_DAYS), active: null },
    { name: "  ", last_seen_at: daysAgo(1), active: true },
    { name: "นพ. จ", last_seen_at: null, active: null },
  ], NOW);
  // เรียงตามชื่อแบบภาษาไทย (localeCompare "th"): ชื่อไทยก่อน ชื่ออังกฤษตามหลัง
  assert.deepEqual(out.map((p) => p.name), ["นพ. ข", "พญ. ก", "Dr. A"]);
  assert.deepEqual(Object.keys(out[0]), ["name", "last_seen_at"], "รูปแบบที่ HR อ่าน");
  assert.equal(out[0].last_seen_at, daysAgo(400), "ISO string");
});

test("route: secret ผิด/ไม่มี = 401 · ถูก = 200 { providers } · ไม่ตั้ง secret = 401 หมด", async () => {
  state.tables.providers = [
    { name: "นพ. สมชาย", last_seen_at: new Date().toISOString(), active: null },
    { name: "นพ. เลิกแล้ว", last_seen_at: new Date().toISOString(), active: false },
  ];
  const get = (auth) => route.GET(new Request("https://app.test/api/hr/providers", { headers: auth ? { authorization: auth } : {} }));
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(`Bearer ${SECRET}x`)).status, 401);
  const res = await get(`Bearer ${SECRET}`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.providers.map((p) => p.name), ["นพ. สมชาย"]);
  assert.match(j.providers[0].last_seen_at, /^\d{4}-\d{2}-\d{2}T/);
  delete process.env.HR_CREDENTIAL_SECRET;
  assert.equal((await get("Bearer undefined")).status, 401);
});
