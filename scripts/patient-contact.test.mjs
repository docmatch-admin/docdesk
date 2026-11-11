// ชื่อ + เบอร์คนไข้สำหรับฟอร์มนัด: iService ฝั่ง server → สำรองจาก patients: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const contact = await import("../src/lib/patient-contact.ts");

beforeEach(() => {
  resetDb({ patients: [{ hn: "000004141", full_name: "ชื่อจากนัดก่อน", phone: "0811111111" }] });
});

test("ใช้ HN เต็ม 9 หลักเรียก iService · ได้เบอร์ → phone_source iservice · ไม่มีข้อมูลอื่นนอกจากชื่อและเบอร์", async () => {
  const calls = [];
  const lookup = async (hn, timeout) => { calls.push([hn, timeout]); return { status: "found", hn, name: " สมชาย ใจดี ", phone: "0899999999", cid: "1234567890123" }; };
  const r = await contact.patientContact("4141", lookup);
  assert.deepEqual(calls, [["000004141", 5000]]);
  assert.deepEqual(r, { hn: "000004141", full_name: "สมชาย ใจดี", phone: "0899999999", phone_source: "iservice" });
  assert.ok(!("cid" in r));
});

test("iService ล้ม/timeout หรือไม่มีเบอร์ → ใช้เบอร์จากตาราง patients (phone_source patients)", async () => {
  for (const lookup of [async () => ({ status: "error" }), async () => { throw new Error("timeout"); }, async () => ({ status: "found", hn: "x", name: "จาก HIS", phone: "" })]) {
    const r = await contact.patientContact("000004141", lookup);
    assert.equal(r.phone, "0811111111");
    assert.equal(r.phone_source, "patients");
  }
});

test("ไม่พบเบอร์ทั้งสองที่ → phone null และ phone_source null", async () => {
  state.tables.patients = [];
  const r = await contact.patientContact("999", async () => ({ status: "not_found" }));
  assert.deepEqual(r, { hn: "000000999", full_name: null, phone: null, phone_source: null });
});

test("ทุกทางเข้าใช้ฟอร์มเดียว: ฟอร์มเติมจาก form-data ไม่ทับช่องที่แก้เอง · ตัวเลือกคนไข้ remount ฟอร์มต่อ HN", () => {
  const form = readFileSync("src/app/(staff)/appointments/appointment-form.tsx", "utf8");
  assert.match(form, /applyPatient\(\(d as FormData\)\.patient \?\? null, hn\)/);
  assert.match(form, /if \(p\?\.phone && !touched\.current\.phone && !f\.phone\.trim\(\)\) next\.phone = p\.phone;/);
  assert.match(form, /touched\.current\.phone = true;/);
  for (const t of ["ดึงจาก iService", "จากนัดครั้งก่อน", "ไม่พบเบอร์ — กรุณากรอก"]) assert.ok(form.includes(t), t);
  const picker = readFileSync("src/app/(staff)/appointments/new-appointment.tsx", "utf8");
  assert.match(picker, /<AppointmentForm key=\{draft\.hn\} initial=\{draft\}/);
  const store = readFileSync("src/lib/appointment-store.ts", "utf8");
  assert.match(store, /hn \? patientContact\(hn\) : Promise\.resolve\(null\)/);
  // ทุกทางเข้าใช้ AppointmentForm (คนไข้วันนี้/ค้นหา, กล่องขวาของแชท, แก้ไขนัด)
  for (const f of ["src/app/(staff)/appointments/new-appointment.tsx", "src/app/(staff)/inbox/appointments-block.tsx", "src/app/(staff)/appointments/appointment-drawer.tsx"]) {
    assert.match(readFileSync(f, "utf8"), /<AppointmentForm /, f);
  }
});
