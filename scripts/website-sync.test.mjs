// ทดสอบราคาจากเว็บ: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { resetDb, state, nextTime } = await import(fake("admin"));
const { storeIncoming } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const {
  fetchWebsitePrograms, parsePrograms, programToKnowledge, runWebsiteSync, syncWebsiteIfDue, withHiddenServices, HIDDEN_LINE_PREFIX,
} = await import("../src/lib/website-sync.ts");
const { applyPriceConflictGuard, buildPriceEntries, findPriceConflicts, noPriceAnswer, NO_PRICE_MARK } = await import("../src/lib/price-catalog.ts");
const { findUnverifiedNumbers, buildNumberSources } = await import("../src/lib/number-guard.ts");
const { matchService, findUnavailableRequest } = await import("../src/lib/booking-rules.ts");
const { loadBookingCatalog } = await import("../src/lib/booking-store.ts");
const knowledgeRoute = await import("../src/app/api/knowledge/route.ts");
const syncRoute = await import("../src/app/api/knowledge/sync/route.ts");

process.env.WEBSITE_SUPABASE_URL = "https://web.test";
process.env.WEBSITE_SUPABASE_KEY = "pk";

const program = (slug, name, price, extra = {}) => ({
  slug, category: "vaccine", name, price, price_unit: price == null ? null : "ต่อเข็ม", price_note: null, options: [], includes: [], updated_at: "2026-10-26T04:24:43+00:00", ...extra,
});
const PROGRAMS = [
  program("contraceptive-injection-3-month", "ฉีดยาคุมกำเนิด 3 เดือน (DMPA)", 150, { category: "family-planning" }),
  program("tetanus-vaccine", "วัคซีนบาดทะยัก", 150),
  program("rsv-vaccine-abrysvo", "วัคซีน RSV (Abrysvo)", 7200, { includes: ["ค่าวัคซีนและค่าฉีด"] }),
  program("flu-vaccine", "วัคซีนไข้หวัดใหญ่ 4 สายพันธุ์", 390),
  program("pep-prep", "PEP / PrEP ยาป้องกันเอชไอวี", null, { category: "sexual-health", price_note: "สอบถามค่ายาทาง LINE @p49clinic" }),
  program("employee-health-checkup", "ตรวจสุขภาพพนักงาน / บริษัท", null, { category: "checkup", price_note: "ขอใบเสนอราคาได้ทาง LINE @p49clinic" }),
  program("health-checkup-basic", "แพ็กเกจตรวจสุขภาพ ชุดเล็ก", 999, { category: "checkup", includes: ["ไขมันในเลือด 4 ค่า", "ไวรัสตับอักเสบบี 2 ค่า"] }),
  program("dengue-vaccine-qdenga", "วัคซีนไข้เลือดออก (Qdenga)", 1800, {
    price_note: "จองคอร์ส 2 เข็ม 3,450 บาท",
    options: [{ label: "วัคซีน 1 เข็ม", price: 1800, note: "ฉีด 2 เข็ม" }, { label: "คอร์ส 2 เข็ม", price: 3450, note: null }],
  }),
];

let web;
const realFetch = globalThis.fetch;
function mockWeb() {
  globalThis.fetch = async (url) => {
    web.urls.push(String(url));
    if (web.fail) throw new Error("เครือข่ายล้ม");
    if (web.status !== 200) return new Response("no", { status: web.status });
    return new Response(JSON.stringify(web.rows), { status: 200 });
  };
}

const MANUAL_UNAVAILABLE = { id: "un", category: "บริการ", title: "บริการที่ยังไม่มี", content: "ยังไม่มีบริการ PRP เข่า", active: true, source: "manual", website_slug: null };
const baseTables = () => ({
  knowledge_items: [
    { id: "hours", category: "ข้อมูลคลินิก", title: "เวลาทำการ", content: "จันทร์–ศุกร์ 08.00–18.00 น.", active: true, source: "manual", website_slug: null, updated_at: nextTime() },
    { ...MANUAL_UNAVAILABLE, updated_at: nextTime() },
  ],
  lab_items: [
    { code: "FBS", name_en: "FBS", name_th: "น้ำตาลในเลือด", price: 100, cost: 25, category: "ไขมัน/น้ำตาล", active: true },
    { code: "HBA1C", name_en: "HbA1c", name_th: "น้ำตาลสะสม", price: 250, cost: 140, category: "ไขมัน/น้ำตาล", active: true },
  ],
  lab_packages: [
    { code: "CHK_S", name: "โปรแกรมตรวจสุขภาพชุดเล็ก", price: 999, cost: 499, includes: [], compare_item_codes: [], items_without_single_price: [], active: true },
    { code: "CHK_F", name: "โปรแกรมตรวจสุขภาพหญิงชุดใหญ่", price: 1300, cost: 799, includes: [], compare_item_codes: [], items_without_single_price: [], active: true },
    { code: "CHK_M", name: "โปรแกรมตรวจสุขภาพชายชุดใหญ่", price: 1399, cost: 999, includes: [], compare_item_codes: [], items_without_single_price: [], active: true },
  ],
  settings: [{ key: "ai_mode", value: "off" }],
  tags: [], reply_examples: [], bookings: [],
  channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true }],
  contacts: [], conversations: [],
});
const FULL = [
  ...PROGRAMS,
  program("health-checkup-female", "แพ็กเกจตรวจสุขภาพ ชุดใหญ่ (ผู้หญิง)", 1300, { category: "checkup" }),
  program("health-checkup-male", "แพ็กเกจตรวจสุขภาพ ชุดใหญ่ (ผู้ชาย)", 1399, { category: "checkup" }),
];
const kb = (slug) => state.tables.knowledge_items.find((k) => k.website_slug === slug);
const status = () => state.tables.settings.find((s) => s.key === "website_sync")?.value;

beforeEach(() => {
  reset();
  resetDb(baseTables());
  web = { rows: FULL, status: 200, fail: false, urls: [] };
  mockWeb();
  state.currentUser = { id: "admin" };
  state.tables.staff = [{ id: "admin", role: "admin", active: true, can_view_sensitive: true, must_change_password: false }];
});
test.after?.(() => { globalThis.fetch = realFetch; });

// ---- แปลงข้อมูล ----
test("ยาฉีดคุม 3 เดือน = 150 หมวดแปลเป็นไทย", () => {
  const k = programToKnowledge(PROGRAMS[0]);
  assert.equal(k.category, "คุมกำเนิด");
  assert.equal(k.title, "ฉีดยาคุมกำเนิด 3 เดือน (DMPA)");
  assert.match(k.content, /^ราคา 150 บาท ต่อเข็ม/);
});

test("เนื้อหารวมราคา ตัวเลือก หมายเหตุ และรายการที่รวม", () => {
  const k = programToKnowledge({ ...PROGRAMS[7], includes: ["ค่าฉีด"] });
  assert.match(k.content, /ราคา 1,800 บาท/);
  assert.match(k.content, /คอร์ส 2 เข็ม 3,450 บาท/);
  assert.match(k.content, /หมายเหตุ: จองคอร์ส/);
  assert.match(k.content, /รวม: ค่าฉีด/);
});

test("ไม่มีราคา: ไม่มีตัวเลขราคา และใช้ price_note", () => {
  const k = programToKnowledge(PROGRAMS[4]);
  assert.ok(k.content.startsWith(NO_PRICE_MARK));
  assert.match(k.content, /สอบถามค่ายาทาง LINE @p49clinic/);
  assert.doesNotMatch(k.content, /\d+\s*บาท/);
});

test("หมวดที่ไม่รู้จักไม่ทำให้ล้ม", () => {
  assert.equal(programToKnowledge(program("x", "บริการใหม่", 10, { category: "new-cat" })).category, "บริการอื่นๆ");
});

test("แถวผิดรูปแบบทำให้ทั้งรอบล้ม ไม่ใช่ถูกข้าม", () => {
  assert.throws(() => parsePrograms("x"));
  assert.throws(() => parsePrograms([{ name: "ไม่มี slug", price: 1 }]));
  assert.throws(() => parsePrograms([{ slug: "a", name: "b", price: "abc" }]));
});

test("ขอเฉพาะแถวที่เผยแพร่และคอลัมน์ที่กำหนด", async () => {
  await fetchWebsitePrograms();
  assert.match(web.urls[0], /^https:\/\/web\.test\/rest\/v1\/hw_programs\?is_published=eq\.true&select=slug,category,name,price,price_unit,price_note,options,includes,updated_at$/);
});

test("ไม่ตั้ง env: ไม่ยิงเว็บ และบันทึกข้อผิดพลาด", async () => {
  const saved = process.env.WEBSITE_SUPABASE_URL;
  delete process.env.WEBSITE_SUPABASE_URL;
  const r = await runWebsiteSync();
  process.env.WEBSITE_SUPABASE_URL = saved;
  assert.equal(r.ok, false);
  assert.equal(web.urls.length, 0);
  assert.match(status().error, /WEBSITE_SUPABASE_URL/);
});

// ---- ซิงก์ ----
test("ซิงก์แล้ว ยาฉีดคุม 3 เดือน = 150 และวัคซีน RSV = 7,200", async () => {
  const r = await runWebsiteSync();
  assert.equal(r.ok, true);
  assert.equal(r.count, FULL.length);
  assert.match(kb("contraceptive-injection-3-month").content, /150 บาท/);
  assert.match(kb("tetanus-vaccine").content, /150 บาท/);
  assert.match(kb("rsv-vaccine-abrysvo").content, /7,200 บาท/);
  assert.equal(kb("rsv-vaccine-abrysvo").source, "website");
  assert.ok(status().last_success_at);
});

test("ซิงก์ซ้ำไม่สร้างแถวซ้ำ และไม่เรียก embedding ถ้าไม่เปลี่ยน", async () => {
  await runWebsiteSync();
  const n = state.tables.knowledge_items.length;
  reset();
  const r = await runWebsiteSync();
  assert.equal(state.tables.knowledge_items.length, n);
  assert.equal(calls.embed, 0);
  assert.equal(r.changed, 0);
});

test("ราคาเปลี่ยนบนเว็บ: แก้แถวเดิมตาม slug และฝังเฉพาะแถวนั้น", async () => {
  await runWebsiteSync();
  const id = kb("flu-vaccine").id;
  web.rows = FULL.map((p) => (p.slug === "flu-vaccine" ? { ...p, price: 450 } : p));
  reset();
  await runWebsiteSync();
  assert.equal(kb("flu-vaccine").id, id);
  assert.match(kb("flu-vaccine").content, /450 บาท/);
  assert.equal(calls.embed, 1);
});

test("ข้อมูลที่ไม่มีบนเว็บไม่ถูกแตะ", async () => {
  await runWebsiteSync();
  const hours = state.tables.knowledge_items.find((k) => k.id === "hours");
  assert.equal(hours.content, "จันทร์–ศุกร์ 08.00–18.00 น.");
  assert.equal(hours.active, true);
});

test("บริการหายจากเว็บ: ปิดใช้และเพิ่มชื่อใน บริการที่ยังไม่มี โดยคงข้อความเดิม", async () => {
  await runWebsiteSync();
  web.rows = FULL.filter((p) => p.slug !== "rsv-vaccine-abrysvo");
  await runWebsiteSync();
  assert.equal(kb("rsv-vaccine-abrysvo").active, false);
  const un = state.tables.knowledge_items.find((k) => k.id === "un");
  assert.match(un.content, /ยังไม่มีบริการ PRP เข่า/);
  assert.ok(un.content.includes(`${HIDDEN_LINE_PREFIX}วัคซีน RSV (Abrysvo)`));
});

test("บริการกลับมาบนเว็บ: เปิดใช้และเอาชื่อออก", async () => {
  await runWebsiteSync();
  web.rows = FULL.filter((p) => p.slug !== "rsv-vaccine-abrysvo");
  await runWebsiteSync();
  web.rows = FULL;
  await runWebsiteSync();
  assert.equal(kb("rsv-vaccine-abrysvo").active, true);
  assert.equal(state.tables.knowledge_items.find((k) => k.id === "un").content, "ยังไม่มีบริการ PRP เข่า");
});

test("ไม่มีรายการ บริการที่ยังไม่มี: สร้างให้เมื่อต้องใช้", async () => {
  await runWebsiteSync();
  state.tables.knowledge_items = state.tables.knowledge_items.filter((k) => k.id !== "un");
  web.rows = FULL.filter((p) => p.slug !== "rsv-vaccine-abrysvo");
  await runWebsiteSync();
  assert.ok(state.tables.knowledge_items.find((k) => k.title === "บริการที่ยังไม่มี").content.includes("วัคซีน RSV"));
});

test("withHiddenServices ไม่ซ้ำเมื่อรันหลายรอบ", () => {
  const once = withHiddenServices("เดิม", ["ข", "ก"]);
  assert.equal(once, `เดิม\n${HIDDEN_LINE_PREFIX}ก\n${HIDDEN_LINE_PREFIX}ข`);
  assert.equal(withHiddenServices(once, ["ก", "ข"]), once);
});

for (const [name, setup, pattern] of [
  ["เว็บล่ม", () => { web.fail = true; }, /เครือข่ายล้ม/],
  ["เว็บตอบ 500", () => { web.status = 500; }, /500/],
  ["เว็บคืนแถวว่าง", () => { web.rows = []; }, /ไม่คืนข้อมูล/],
  ["เว็บคืนแถวเสีย", () => { web.rows = [{ slug: "x" }]; }, /ไม่ครบ/],
]) {
  test(`${name}: ข้อมูลเดิมอยู่ครบ และแจ้งข้อผิดพลาด`, async () => {
    await runWebsiteSync();
    const before = JSON.stringify(state.tables.knowledge_items);
    setup();
    const r = await runWebsiteSync();
    assert.equal(r.ok, false);
    assert.match(status().error, pattern);
    assert.ok(status().last_success_at);
    assert.equal(JSON.stringify(state.tables.knowledge_items), before);
  });
}

test("บริการหายมากผิดปกติ: ไม่ปิดจนกว่า admin ยืนยัน", async () => {
  await runWebsiteSync();
  web.rows = FULL.slice(0, 2);
  const r = await runWebsiteSync();
  assert.equal(r.needs_confirm, true);
  assert.equal(kb("rsv-vaccine-abrysvo").active, true);
  const forced = await runWebsiteSync({ force: true });
  assert.equal(forced.ok, true);
  assert.equal(kb("rsv-vaccine-abrysvo").active, false);
  assert.equal(status().needs_confirm, false);
});

test("cron: ซิงก์ชั่วโมงละครั้ง นับจากครั้งที่ลองล่าสุดแม้ล้มเหลว", async () => {
  const t0 = Date.parse("2026-11-02T10:00:00Z");
  web.fail = true;
  assert.equal(await syncWebsiteIfDue(t0), true);
  const hits = web.urls.length;
  assert.equal(hits, 1);
  assert.equal(await syncWebsiteIfDue(t0 + 59 * 60_000), false);
  assert.equal(web.urls.length, hits);
  web.fail = false;
  assert.equal(await syncWebsiteIfDue(t0 + 60 * 60_000), true);
  assert.equal(status().error, null);
});

test("cron เรียกซิงก์ และซิงก์ล้มไม่กระทบงานอื่น", () => {
  const src = readFileSync("src/app/api/cron/fallback/route.ts", "utf8");
  assert.match(src, /try \{\s*websiteSynced = await syncWebsiteIfDue\(\);/);
});

// ---- แพ็กเกจ ----
test("ราคาแพ็กเกจตรงกับเว็บ: ไม่แจ้งเตือน", async () => {
  await runWebsiteSync();
  assert.deepEqual(status().alerts, []);
});

test("ราคาแพ็กเกจไม่ตรง: ใช้ราคาเว็บ แจ้งเตือน และไม่แตะต้นทุน", async () => {
  state.tables.lab_packages[0].price = 899;
  await runWebsiteSync();
  const p = state.tables.lab_packages[0];
  assert.equal(p.price, 999);
  assert.equal(p.cost, 499);
  assert.equal(status().alerts.length, 1);
  assert.match(status().alerts[0].message, /899 เป็น 999/);
  assert.doesNotMatch(JSON.stringify(status()), /499/);
});

test("แจ้งเตือนอยู่จนกดรับทราบ แม้รอบถัดไปราคาตรงแล้ว", async () => {
  state.tables.lab_packages[0].price = 899;
  await runWebsiteSync();
  await runWebsiteSync();
  assert.equal(status().alerts.length, 1);
  const res = await syncRoute.PATCH();
  assert.equal(res.status, 200);
  assert.deepEqual(status().alerts, []);
});

test("แพ็กเกจหายจากเว็บ: ไม่เปลี่ยนราคาแต่แจ้งเตือน", async () => {
  web.rows = FULL.filter((p) => p.slug !== "health-checkup-male");
  await runWebsiteSync();
  assert.equal(state.tables.lab_packages[2].price, 1399);
  assert.ok(status().alerts.some((a) => a.code === "CHK_M" && /ไม่พบราคาบนเว็บ/.test(a.message)));
});

test("ราคาแล็บรายการเดี่ยวไม่เปลี่ยนตามเว็บ", async () => {
  web.rows = [...FULL, program("lab-test-single", "ตรวจเลือด / ตรวจแล็บรายการเดี่ยว", 100, { category: "checkup" })];
  await runWebsiteSync();
  assert.equal(state.tables.lab_items.find((i) => i.code === "HBA1C").price, 250);
});

// ---- แก้ใน DocDesk ----
test("แก้แถวจากเว็บผ่าน API ไม่ได้", async () => {
  await runWebsiteSync();
  const row = kb("tetanus-vaccine");
  const res = await knowledgeRoute.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ id: row.id, title: "วัคซีนบาดทะยัก", content: "100 บาท" }) }));
  assert.equal(res.status, 409);
  assert.match(kb("tetanus-vaccine").content, /150 บาท/);
});

test("ข้อมูลที่ไม่มีบนเว็บยังแก้ได้", async () => {
  const res = await knowledgeRoute.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ id: "hours", category: "ข้อมูลคลินิก", title: "เวลาทำการ", content: "เปิดทุกวัน" }) }));
  assert.equal(res.status, 200);
  assert.equal(state.tables.knowledge_items.find((k) => k.id === "hours").content, "เปิดทุกวัน");
});

test("trigger กันแถวจากเว็บทุกคำสั่ง และยกเว้น service role", () => {
  const sql = readFileSync("supabase/migrations/028_website_knowledge.sql", "utf8");
  assert.match(sql, /before insert or update or delete on knowledge_items/);
  assert.match(sql, /auth\.uid\(\) is null/);
  assert.match(sql, /old\.source = 'website'/);
  assert.match(sql, /new\.source = 'website'/);
});

test("API ซิงก์: เฉพาะ admin", async () => {
  state.tables.staff[0].role = "agent";
  const res = await syncRoute.POST(new Request("http://x", { method: "POST", body: "{}" }));
  assert.equal(res.status, 403);
  assert.equal(web.urls.length, 0);
  assert.equal((await syncRoute.PATCH()).status, 403);
});

test("หน้าฐานข้อมูล: แถวจากเว็บมีป้ายและไม่มีปุ่มแก้", () => {
  const src = readFileSync("src/app/(staff)/knowledge/knowledge-client.tsx", "utf8");
  assert.match(src, /i\.source === "website" \|\| i\.source === "website_page" \? <span className="chip">จากเว็บ — แก้ที่หลังบ้านเว็บ<\/span>/);
  assert.match(src, /ซิงก์จากเว็บตอนนี้/);
});

// ---- ตัวกันราคา ----
const WEB_ROWS = FULL.map((p) => ({ website_slug: p.slug, ...programToKnowledge(p) }));
const LAB = [
  { code: "FBS", name_en: "FBS", name_th: "น้ำตาลในเลือด", price: 100 },
  { code: "HBA1C", name_en: "HbA1c", name_th: "น้ำตาลสะสม", price: 250 },
  { code: "T3", name_en: "T3", name_th: "ไทรอยด์", price: 200 },
];
const PACKS = [{ name: "โปรแกรมตรวจสุขภาพชุดเล็ก", price: 999 }];
const entries = buildPriceEntries(WEB_ROWS, LAB, PACKS);
const conflict = (answer, question = "") => findPriceConflicts(answer, question, entries).map((c) => c.price);

for (const [answer, question, expected] of [
  ["ตรวจน้ำตาล 150 บาทค่ะ", "", [150]],
  ["ตรวจน้ำตาล 100 บาทค่ะ", "", []],
  ["น้ำตาลสะสม 250 บาทค่ะ", "", []],
  ["น้ำตาลสะสม 100 บาทค่ะ", "", [100]],
  ["ตรวจน้ำตาล 150", "", [150]],
  ["ยาคุม 3 เดือน 100 บาทค่ะ", "", [100]],
  ["ยาคุม 3 เดือน 150 บาทค่ะ", "", []],
  ["วัคซีนบาดทะยัก เข็มละ 100 บาท", "", [100]],
  ["วัคซีนบาดทะยัก เข็มละ 150 บาท", "", []],
  ["วัคซีน RSV 7,200 บาทค่ะ", "", []],
  ["วัคซีน RSV ๗,๒๐๐ บาทค่ะ", "", []],
  ["RSV 5,000 บาทค่ะ", "", [5000]],
  ["เข็มละ 5,000 บาทค่ะ", "ราคาวัคซีน RSV", [5000]],
  ["เข็มละ 7,200 บาทค่ะ", "ราคาวัคซีน RSV", []],
  ["คอร์ส 3,450 บาทค่ะ", "วัคซีนไข้เลือดออก", []],
  ["PEP 3,000 บาทค่ะ", "", [3000]],
  ["ประมาณ 3,000 บาทค่ะ", "PEP ราคาเท่าไหร่", [3000]],
  ["สอบถามค่ายาทาง LINE @p49clinic", "PEP ราคาเท่าไหร่", []],
  ["ค่าบริการ 30 บาทค่ะ", "", []],
  ["เหมาจ่าย 360 บาทค่ะ", "", []],
]) {
  test(`ตัวกันราคา: "${answer}" ถามว่า "${question}" → ${expected.join(",") || "ผ่าน"}`, () => {
    assert.deepEqual(conflict(answer, question), expected);
  });
}

test("เบอร์โทรและเวลาไม่ถูกนับเป็นราคา", () => {
  assert.deepEqual(conflict("วัคซีน RSV โทร 02-000-4586 เปิด 08.00 น.ค่ะ"), []);
  assert.deepEqual(conflict("วัคซีนไข้หวัดใหญ่ 4 สายพันธุ์ มาได้ 18.00 น."), []);
});

test("วันที่ไม่ถูกนับเป็นราคา", () => {
  assert.deepEqual(conflict("injection (DMPA) on 30 October 2026"), []);
  assert.deepEqual(conflict("ฉีด DMPA 30 ต.ค. ค่ะ"), []);
});

test("ชุดใหญ่รวมราคาหญิงและชาย", () => {
  assert.deepEqual(conflict("ชุดใหญ่ 1,300 บาท"), []);
  assert.deepEqual(conflict("ชุดใหญ่ 1,399 บาท"), []);
  assert.deepEqual(conflict("ชุดใหญ่ 2,000 บาท"), [2000]);
});

test("คำตอบราคาขัด: ส่งเองไม่ได้และเตือน", () => {
  const out = applyPriceConflictGuard({ text: "ตรวจน้ำตาล 150 บาทค่ะ", confidence: 0.9 }, "", entries);
  assert.equal(out.confidence, 0.5);
  assert.match(out.note, /150 บาท ไม่ตรงกับราคาในระบบ 100/);
});

test("บริการไม่มีราคาแต่ AI บอกตัวเลข: ความมั่นใจเป็น 0", () => {
  const out = applyPriceConflictGuard({ text: "PEP 3,000 บาทค่ะ", confidence: 0.9 }, "", entries);
  assert.equal(out.confidence, 0);
});

test("คำถามราคาบริการไม่มีราคา: ได้ข้อความจากเว็บ", () => {
  assert.equal(noPriceAnswer("PEP ราคาเท่าไหร่", entries), "สอบถามค่ายาทาง LINE @p49clinic");
  assert.equal(noPriceAnswer("ตรวจสุขภาพพนักงานกี่บาท", entries), "ขอใบเสนอราคาได้ทาง LINE @p49clinic");
  assert.equal(noPriceAnswer("PEP คืออะไร", entries), null);
  assert.equal(noPriceAnswer("วัคซีน RSV ราคาเท่าไหร่", entries), null);
  assert.equal(noPriceAnswer("pepsi ราคาเท่าไหร่", entries), null);
});

test("ราคายืนยันได้จาก knowledge และแล็บเท่านั้น ไม่ใช่คำตอบเก่าหรือแชท", () => {
  const sources = buildNumberSources({
    knowledge: [{ title: "วัคซีน", content: "390 บาท" }],
    examples: [{ answer: "ตรวจน้ำตาล 150 บาทค่ะ" }],
    msgs: [{ sender_type: "staff", body: "พิเศษ 777 บาทค่ะ", body_th: null }],
    extraTrusted: ["FBS 100 บาท"],
  });
  assert.deepEqual(findUnverifiedNumbers("150 บาทค่ะ", sources), ["150"]);
  assert.deepEqual(findUnverifiedNumbers("777 บาทค่ะ", sources), ["777"]);
  assert.deepEqual(findUnverifiedNumbers("390 บาทค่ะ", sources), []);
  assert.deepEqual(findUnverifiedNumbers("100 บาทค่ะ", sources), []);
});

test("เวลาจากเจ้าหน้าที่ยังยืนยันได้เหมือนเดิม", () => {
  const sources = buildNumberSources({ knowledge: [], examples: [], msgs: [{ sender_type: "staff", body: "นัด 14.30 น.", body_th: null }] });
  assert.deepEqual(findUnverifiedNumbers("มา 14.30 น. นะคะ", sources), []);
});

// ---- ต่อกับการร่างคำตอบ ----
async function chat(text) {
  const s = await storeIncoming({ channelType: "web", externalId: "11111111-1111-4111-8111-111111111111", text });
  return s.conversationId;
}

test("คำตอบเก่าราคาผิดไม่ถูกส่งให้ AI", async () => {
  await runWebsiteSync();
  state.matchExamples = [{ id: "e1", question: "ตรวจน้ำตาลเท่าไหร่", answer: "ตรวจน้ำตาล 150 บาทค่ะ", starred: false, use_count: 3, created_at: nextTime(), similarity: 0.9 }];
  replies.next = { needs_human: false, options: [{ text: "ตรวจน้ำตาล 150 บาทค่ะ", source: "example", ref_ids: [], confidence: 0.9 }] };
  const id = await chat("ตรวจน้ำตาลเท่าไหร่คะ");
  const r = await generateSuggestions(id, { force: true });
  assert.doesNotMatch(calls.lastPrompt, /ตรวจน้ำตาล 150 บาท/);
  assert.ok(r.options[0].confidence <= 0.5);
  assert.match(r.options[0].note, /ไม่ตรงกับราคาในระบบ/);
});

test("คำถามตรวจน้ำตาลได้ราคาแล็บใน prompt", async () => {
  await runWebsiteSync();
  const id = await chat("ตรวจน้ำตาลเท่าไหร่คะ");
  await generateSuggestions(id, { force: true });
  assert.match(calls.lastPrompt, /FBS \(น้ำตาลในเลือด\) 100 บาท/);
});

test("คำตอบติดดาวราคาผิดไม่ถูกตอบแทน AI", async () => {
  await runWebsiteSync();
  state.matchKnowledge = [{ ...kb("tetanus-vaccine"), similarity: 0.9 }, { id: "x", category: "ก", title: "อื่น", content: "100 บาท", updated_at: nextTime(), similarity: 0.9 }];
  state.matchExamples = [{ id: "e2", question: "วัคซีนบาดทะยักเท่าไหร่", answer: "วัคซีนบาดทะยัก 100 บาทค่ะ", starred: true, use_count: 9, created_at: nextTime(), similarity: 0.99 }];
  const id = await chat("วัคซีนบาดทะยักเท่าไหร่");
  await generateSuggestions(id);
  assert.equal(calls.chat, 1);
});

test("ถามราคา PEP: ตัวเลือกแรกเป็นข้อความจากเว็บ และไม่เดาราคา", async () => {
  await runWebsiteSync();
  state.matchKnowledge = [{ ...kb("pep-prep"), similarity: 0.9 }];
  replies.next = { needs_human: false, options: [{ text: "ประมาณ 3,000 บาทค่ะ", source: "knowledge", ref_ids: [], confidence: 0.9 }] };
  const id = await chat("PEP ราคาเท่าไหร่คะ");
  const r = await generateSuggestions(id, { force: true });
  assert.equal(r.options[0].text, "สอบถามค่ายาทาง LINE @p49clinic");
  assert.equal(r.options[1].confidence, 0);
  assert.match(calls.lastPrompt, /ไม่มีราคาบนเว็บ/);
});

test("ถามราคา RSV: ข้อมูลส่งให้ AI มี 7,200 และคำตอบถูกผ่าน", async () => {
  await runWebsiteSync();
  state.matchKnowledge = [{ ...kb("rsv-vaccine-abrysvo"), similarity: 0.9 }];
  replies.next = { needs_human: false, options: [{ text: "วัคซีน RSV เข็มละ 7,200 บาทค่ะ", source: "knowledge", ref_ids: [], confidence: 0.9 }] };
  const id = await chat("วัคซีน RSV ราคาเท่าไหร่");
  const r = await generateSuggestions(id, { force: true });
  assert.match(calls.lastPrompt, /7,200 บาท/);
  assert.equal(r.options[0].confidence, 0.9);
  assert.equal(r.options[0].note, undefined);
});

test("ต้นทุนไม่อยู่ใน prompt", async () => {
  await runWebsiteSync();
  const id = await chat("ตรวจน้ำตาลเท่าไหร่");
  await generateSuggestions(id, { force: true });
  assert.doesNotMatch(calls.lastPrompt, /"cost"|ต้นทุน/);
});

// ---- จอง ----
test("จองบริการที่ปิดบนเว็บ: ไม่รับ แต่วัคซีนตัวอื่นยังรับ", async () => {
  await runWebsiteSync();
  web.rows = FULL.filter((p) => p.slug !== "rsv-vaccine-abrysvo");
  await runWebsiteSync();
  const catalog = await loadBookingCatalog();
  assert.equal(matchService("วัคซีน RSV (Abrysvo)", catalog), "unavailable");
  assert.equal(findUnavailableRequest("ขอจอง วัคซีน RSV (Abrysvo) พรุ่งนี้", catalog), "วัคซีน RSV (Abrysvo)");
  assert.equal(matchService("วัคซีนบาดทะยัก", catalog), "known");
  assert.equal(findUnavailableRequest("ขอจองวัคซีนบาดทะยัก", catalog), null);
  assert.equal(matchService("PRP เข่า", catalog), "unavailable");
});
