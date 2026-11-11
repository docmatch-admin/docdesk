// e2e: คลิกเลือกคนไข้ในฟอร์มทำนัดจริงใน Chrome แล้วตรวจว่าช่องเบอร์โทรถูกเติม: npm run test:e2e
// ใช้ component จริง (NewAppointment + AppointmentForm) mock เฉพาะ network (Edge Function iservice และ /api/appointments/*)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { bundle, chromeAvailable, openPage } from "./browser.mjs";

const SKIP = !chromeAvailable() && "ไม่พบ Chrome (ตั้ง CHROME_PATH)";
const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

const SUPABASE_STUB = `
const chain = new Proxy({}, { get(_, k) { if (k === "then") return (res) => res({ data: [], error: null, count: 0 }); return () => chain; } });
exports.supabaseBrowser = () => ({
  functions: { invoke: async (name, { body }) => {
    window.__calls.push("functions/" + name + ":" + body.action);
    if (body.action === "visits") return { data: { visits: window.__visits }, error: null };
    if (body.action === "patients") return { data: { patients: window.__visits.map((v) => ({ hn: v.hn, name: v.name, phone: "" })) }, error: null };
    return { data: { patient: null }, error: null };
  } },
  from: () => chain,
  rpc: () => chain,
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel() {},
});`;
const STUBS = {
  "@/lib/supabase/browser": SUPABASE_STUB,
  "next/navigation": `exports.useRouter = () => ({ push() {}, replace() {}, refresh() {} }); exports.usePathname = () => "/appointments";`,
  "next/link": `const { jsx } = require("react/jsx-runtime"); exports.default = function Link(p) { return jsx("a", { ...p, href: p.href }); }; exports.__esModule = true;`,
};
const ENTRY = `
import { createRoot } from "react-dom/client";
import { NewAppointment } from "@/app/(staff)/appointments/new-appointment";
createRoot(document.getElementById("root")!).render(<NewAppointment onClose={() => {}} />);
`;

// network mock: form-data ตอบช้าได้ (ตั้ง window.__delay) และเลือกแหล่งเบอร์ได้ (window.__patient)
const MOCK = `
window.__calls = [];
window.__delay = 300;
window.__visits = [{ hn: "000004141", name: "ตัวอย่าง ทดสอบ", doctor: "นพ.ตัวอย่าง", time: "09:10", phone: "", seq: 1, vn: "v1", date: "2026-11-11" }];
window.__patient = { hn: "000004141", full_name: "ตัวอย่าง ทดสอบระบบ", phone: "0812345678", phone_source: "iservice" };
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
window.fetch = async (input) => {
  const url = new URL(String(input), "http://app.test");
  window.__calls.push(url.pathname + url.search);
  if (url.pathname === "/api/appointments/form-data") {
    const hn = url.searchParams.get("hn");
    await new Promise((r) => setTimeout(r, window.__delay));
    return json({ presets: [], purposeHistory: [], providers: [], linked: null, templates: [], patient: hn ? window.__patient : null });
  }
  if (url.pathname === "/api/appointments" && url.searchParams.get("upcoming_hns")) return json({ hns: [] });
  return json({});
};`;

let page;
let bundleCode;
before(() => { if (!SKIP) bundleCode = bundle(ENTRY, STUBS); });
after(() => page?.close());

async function freshPage(setup = "") {
  page?.close();
  page = await openPage(`<!doctype html><html lang="th"><head><meta charset="utf-8"><style>${css}</style></head><body>
<div id="root"></div><script>${MOCK}\n${setup}</script><script>${bundleCode}</script></body></html>`);
  await page.waitFor(`document.querySelector(".appt-pick") !== null`);
  return page;
}
const phone = () => page.evaluate(`document.querySelector('input[name="phone"]')?.value ?? null`);
const note = () => page.evaluate(`document.querySelector(".appt-phone-note")?.textContent ?? null`);

test("แท็บคนไข้วันนี้: คลิกคนไข้ → ช่องเบอร์เติมจาก iService (ผ่าน form-data ฝั่ง server) + สถานะ", { skip: SKIP }, async () => {
  await freshPage();
  await page.click(".appt-pick");
  await page.waitFor(`document.querySelector('input[name="phone"]')?.value === "0812345678"`);
  assert.equal(await phone(), "0812345678");
  assert.equal(await note(), "ดึงจาก iService");
  const calls = await page.evaluate("window.__calls");
  assert.ok(calls.some((c) => c.startsWith("/api/appointments/form-data?hn=000004141")), calls.join("\n"));
  assert.ok(!calls.some((c) => c.endsWith(":patient")), "ไม่ดึงซ้ำจากหน้าเว็บ");
  // ชื่อจาก HIS แทนชื่อในรายการ (ยังไม่ได้แก้เอง)
  assert.equal(await page.evaluate(`document.querySelector('input[required]').value`), "ตัวอย่าง ทดสอบระบบ");
});

test("แท็บค้นหา: ค้น HN แล้วคลิกผล → ช่องเบอร์เติม", { skip: SKIP }, async () => {
  await freshPage();
  await page.click('[role="tab"]:nth-child(2)');
  await page.type('input[aria-label="ค้นหาคนไข้เก่า"]', "4141");
  await page.waitFor(`document.querySelectorAll(".appt-pick").length > 0 && document.querySelector('input[aria-label="ค้นหาคนไข้เก่า"]') !== null`);
  await page.click(".appt-pick");
  await page.waitFor(`document.querySelector('input[name="phone"]')?.value === "0812345678"`);
});

test("พยาบาลพิมพ์เบอร์เองระหว่างรอ → ไม่ถูกเขียนทับเมื่อผลมาถึง", { skip: SKIP }, async () => {
  await freshPage("window.__delay = 1500;");
  await page.click(".appt-pick");
  await page.type('input[name="phone"]', "0899");
  await page.waitFor(`window.__calls.some((c) => c.startsWith("/api/appointments/form-data?hn="))`);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(await phone(), "0899");
});

test("iService ล้ม → เบอร์จากนัดครั้งก่อน · ไม่พบเลย → ช่องว่าง + บอกให้กรอก", { skip: SKIP }, async () => {
  await freshPage(`window.__patient = { hn: "000004141", full_name: null, phone: "0855555555", phone_source: "patients" };`);
  await page.click(".appt-pick");
  await page.waitFor(`document.querySelector('input[name="phone"]')?.value === "0855555555"`);
  assert.equal(await note(), "จากนัดครั้งก่อน");

  await freshPage(`window.__patient = { hn: "000004141", full_name: null, phone: null, phone_source: null };`);
  await page.click(".appt-pick");
  await page.waitFor(`document.querySelector(".appt-phone-note")?.textContent === "ไม่พบเบอร์ — กรุณากรอก"`);
  assert.equal(await phone(), "");
});
