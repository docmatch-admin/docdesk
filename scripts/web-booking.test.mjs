// คำขอจองคิวจากหน้าเว็บ (ข้อความ LINE จากฟอร์มบนเว็บ): npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const { parseWebBookingRequest, parseThaiDate } = await import("../src/lib/web-booking.ts");

test("อ่านข้อความจองคิวจากเว็บ", () => {
  const r = parseWebBookingRequest(`สวัสดีค่ะ ต้องการจองคิว
โปรแกรม: วัคซีนพิษสุนัขบ้า (วัคซีนพิษสุนัขบ้า)
ราคา: ฿390
ชื่อ-นามสกุล: จักรพันธ์ จันทร์หอม
เบอร์โทร: 0659848223
วันที่สะดวก:  14/11/69`);
  assert.deepEqual(r, { service: "วัคซีนพิษสุนัขบ้า", name: "จักรพันธ์ จันทร์หอม", phone: "0659848223", date: "2026-11-14", time: null });
});

test("วันที่หลายรูปแบบ · ข้อความทั่วไปไม่ใช่คำขอจอง", () => {
  assert.equal(parseThaiDate("14/11/2569"), "2026-11-14");
  assert.equal(parseThaiDate("14/11/2026"), "2026-11-14");
  assert.equal(parseThaiDate("2026-11-14"), "2026-11-14");
  assert.equal(parseThaiDate("31/02/69"), null);
  assert.equal(parseWebBookingRequest("อยากจองคิวค่ะ"), null);
  assert.equal(parseWebBookingRequest("โปรแกรม: ตรวจสุขภาพ"), null);
  assert.equal(parseWebBookingRequest("ต้องการจองคิว\nโปรแกรม: ตรวจสุขภาพ\nเวลาที่สะดวก: 9.30")?.time, "09:30");
});

test("กล่องขวาของแชทแสดงคำขอจองจากเว็บพร้อมปุ่มยืนยันลงนัด", () => {
  const card = readFileSync("src/app/(staff)/inbox/web-booking-card.tsx", "utf8");
  assert.match(card, /ยืนยันลงนัด/);
  const client = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(client, /<WebBookingCard /);
});

test("คำขอจองที่ลงนัดไปแล้ว (แม้เลื่อนวัน) ไม่ขึ้นซ้ำ", () => {
  const card = readFileSync("src/app/(staff)/inbox/web-booking-card.tsx", "utf8");
  assert.match(card, /Date\.parse\(latestApptAt\) > Date\.parse\(found\.at\)/);
});
