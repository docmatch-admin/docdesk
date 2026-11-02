// ทดสอบระบบจอง: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { sendReply, storeIncoming, tryAutoSend, autoCloseQuietChats } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const {
  decideBooking, DEFAULT_BOOKING_TEMPLATES, extractPhone, fillTemplate, hasBookingSignal, isStillBookable, maskBookingPii, matchService,
  findUnavailableRequest, nearestSlots, normalizeBookingTemplates, parseBookingDate, parseBookingTime, rescheduleText, resolveBookingDate, resolveBookingTime, thaiDate, thaiWeekday,
} = await import("../src/lib/booking-rules.ts");
const { pushPendingBookings, shouldPushBooking } = await import("../src/lib/booking-store.ts");
const { isWaitingForReply, tabsOf } = await import("../src/lib/case-flow.ts");
const closeRoute = await import("../src/app/api/conversations/[id]/close/route.ts");
const sendRoute = await import("../src/app/api/conversations/[id]/send/route.ts");
const recordRoute = await import("../src/app/api/bookings/[id]/record/route.ts");
const bookingRoute = await import("../src/app/api/bookings/[id]/route.ts");
const draftRoute = await import("../src/app/api/bookings/[id]/draft/route.ts");

// พุธ 2 ม.ค. 2030 10.00 น. เวลาไทย ใช้ปีไกล เพราะการบันทึกนัดเทียบกับนาฬิกาจริง
const NOW = Date.parse("2030-01-02T03:00:00Z");
const HOURS = {
  tz: "Asia/Bangkok",
  days: { 0: ["08:00", "12:00"], 1: ["08:00", "18:00"], 2: ["08:00", "18:00"], 3: ["08:00", "18:00"], 4: ["08:00", "18:00"], 5: ["08:00", "18:00"], 6: ["08:00", "12:00"] },
};
const CATALOG = {
  names: ["วัคซีนไข้หวัดใหญ่ 4 สายพันธุ์", "ใบรับรองแพทย์", "CBC", "โปรแกรมตรวจสุขภาพชุดเล็ก"],
  contents: ["สิทธิเงินสด ครอบคลุมตรวจรักษา"],
  unavailableText: "ยังไม่มีบริการ PRP เข่า เยี่ยมบ้านผู้สูงอายุ และดูแลโรคเรื้อรังแบบผู้จัดการ",
};
const decide = (req, current = null, now = NOW) => decideBooking(req, { catalog: CATALOG, hours: HOURS, now, current });
const FLU = "วัคซีนไข้หวัดใหญ่";

test("ปีไทยและวันที่ไม่จริง", () => {
  assert.equal(parseBookingDate("2573-01-03"), "2030-01-03");
  assert.equal(parseBookingDate("2030-02-31"), null);
  assert.equal(parseBookingDate("พรุ่งนี้"), null);
  assert.equal(parseBookingDate(null), null);
  assert.equal(parseBookingTime("9:30"), "09:30");
  assert.equal(parseBookingTime("15.00"), "15:00");
  assert.equal(parseBookingTime("25:00"), null);
});

// วันนี้ในเทสต์คือพุธ 2 ม.ค. 2030
for (const [text, ai, want] of [
  ["พรุ่งนี้ค่ะ", "2030-01-04", "2030-01-03"],
  ["ขอพรุ่งนี้", null, "2030-01-03"],
  ["มะรืนนี้", "2030-01-09", "2030-01-04"],
  ["วันนี้สะดวก", "2030-01-03", "2030-01-02"],
  ["เมื่อวาน", "2030-01-03", "2030-01-01"],
  ["ศุกร์นี้", "2030-01-05", "2030-01-04"],
  ["ศุกร์หน้า", "2030-01-11", "2030-01-11"],
  ["วันอาทิตย์", null, "2030-01-06"],
  ["อาทิตย์บ่าย 3", "2030-01-07", "2030-01-06"],
  ["พุธ", "2030-01-09", "2030-01-09"],
  ["5 ม.ค. ค่ะ", "2030-01-05", "2030-01-05"],
  ["อาทิตย์หน้า", "2030-01-08", "2030-01-08"],
  ["สะดวกช่วงเช้า", "2030-01-08", "2030-01-08"],
]) {
  test(`วันที่จากคำพูด "${text}" AI ตอบ ${ai}: ${want}`, () => assert.equal(resolveBookingDate(text, ai, "2030-01-02"), want));
}
for (const [text, ai, want] of [
  ["10 โมง", "11:00", "10:00"], ["10 โมงครึ่ง", null, "10:30"], ["8 โมงเช้า", null, "08:00"], ["บ่าย 3", "03:00", "15:00"],
  ["บ่าย 2 ครึ่ง", null, "14:30"], ["บ่ายโมง", null, "13:00"], ["เที่ยง", null, "12:00"], ["4 โมงเย็น", "04:00", "16:00"],
  ["4 โมง", "04:00", "16:00"], ["2 ทุ่ม", null, "20:00"], ["ตี 1", null, "01:00"], ["09:30 น.", null, "09:30"], ["14.15", null, "14:15"],
  ["ช่วงเช้า", "09:00", "09:00"], ["เบอร์ [เบอร์โทร]", null, null],
]) {
  test(`เวลาจากคำพูด "${text}": ${want}`, () => assert.equal(resolveBookingTime(text, ai), want));
}
test("พบคำขอจองบริการที่ยังไม่มี", () => {
  assert.equal(findUnavailableRequest("ขอจอง PRP เข่าพรุ่งนี้", CATALOG), "PRP");
  assert.equal(findUnavailableRequest("มี PRP ไหม", CATALOG), null, "แค่ถาม ไม่ได้จอง");
  assert.equal(findUnavailableRequest("ขอจองวัคซีน", CATALOG), null);
});

test("พรุ่งนี้ 10 โมง: ยืนยัน", () => assert.equal(decide({ service: FLU, date: "2030-01-03", time: "10:00" }).action, "confirm"));

test("เวลาสุดท้ายก่อนปิด 30 นาที", () => {
  assert.equal(decide({ service: FLU, date: "2030-01-03", time: "17:30" }).action, "confirm");
  assert.equal(decide({ service: FLU, date: "2030-01-03", time: "17:31" }).action, "offer_closed");
  assert.equal(decide({ service: FLU, date: "2030-01-06", time: "11:30" }).action, "confirm");
  assert.equal(decide({ service: FLU, date: "2030-01-06", time: "11:45" }).action, "offer_closed");
});

test("อาทิตย์บ่าย 3: เสนอเวลาเปิดที่ใกล้ที่สุด 2 ตัวเลือก", () => {
  const d = decide({ service: FLU, date: "2030-01-06", time: "15:00" });
  assert.equal(d.action, "offer_closed");
  assert.deepEqual(d.slots, [{ date: "2030-01-06", time: "11:30" }, { date: "2030-01-07", time: "15:00" }]);
});

test("ก่อนเปิด: เสนอเวลาเปิด", () => {
  assert.deepEqual(decide({ service: FLU, date: "2030-01-03", time: "07:00" }).slots[0], { date: "2030-01-03", time: "08:00" });
});

test("วันปิดทั้งวัน: เสนอวันถัดไป", () => {
  const hours = { ...HOURS, days: { ...HOURS.days, 4: null } };
  assert.equal(nearestSlots("2030-01-03", "10:00", hours, NOW)[0].date, "2030-01-04");
});

test("เวลาผ่านแล้วในวันนี้: ถามใหม่พร้อมเสนอเวลาหลังตอนนี้", () => {
  const d = decide({ service: FLU, date: "2030-01-02", time: "09:00" });
  assert.equal(d.action, "offer_past");
  assert.deepEqual(d.slots, [{ date: "2030-01-02", time: "10:30" }, { date: "2030-01-03", time: "09:00" }]);
});

test("วันที่ผ่านแล้ว: เสนอตั้งแต่วันนี้", () => {
  const d = decide({ service: FLU, date: "2029-12-25", time: "10:00" });
  assert.equal(d.action, "offer_past");
  assert.ok(d.slots.every((s) => s.date >= "2030-01-02"));
});

test("ใกล้ปิดแล้ววันนี้: ไม่เสนอเวลาวันนี้ที่หมดแล้ว", () => {
  const late = Date.parse("2030-01-02T10:45:00Z"); // 17.45 น.
  assert.equal(decide({ service: FLU, date: "2030-01-02", time: "09:00" }, null, late).slots[0].date, "2030-01-03");
});

test("ไม่ได้ตั้งเวลาทำการ: ไม่ยืนยันและไม่เสนอเวลา", () => {
  const d = decideBooking({ service: FLU, date: "2030-01-03", time: "10:00" }, { catalog: CATALOG, hours: { tz: "Asia/Bangkok", days: {} }, now: NOW });
  assert.equal(d.action, "ask_datetime");
});

for (const req of [{ service: FLU }, { service: FLU, date: "2030-01-03" }, { service: FLU, time: "10:00" }, { service: FLU, date: "ไม่รู้", time: "x" }]) {
  test(`ไม่บอกวันเวลา ${JSON.stringify(req)}: ถาม`, () => assert.equal(decide(req).action, "ask_datetime"));
}
test("ไม่บอกบริการ: ถาม", () => assert.equal(decide({ date: "2030-01-03", time: "10:00" }).action, "ask_service"));

for (const service of ["PRP เข่า", "PRP หัวเข่า", "ฉีด PRP", "เยี่ยมบ้านผู้สูงอายุ"]) {
  test(`บริการที่ยังไม่มี: ${service} ไม่รับ แม้เวลาถูก`, () => assert.equal(decide({ service, date: "2030-01-03", time: "10:00" }).action, "unavailable"));
}
test("บริการไม่อยู่ในฐานข้อมูล: ไม่รับ", () => assert.equal(decide({ service: "ทำฟัน", date: "2030-01-03", time: "10:00" }).action, "unknown_service"));

test("จับชื่อบริการ", () => {
  assert.equal(matchService("ไข้หวัดใหญ่", CATALOG), "known");
  assert.equal(matchService("cbc", CATALOG), "known");
  assert.equal(matchService("ตรวจรักษา", CATALOG), "known");
  assert.equal(matchService("ตรวจสุขภาพชุดเล็ก", CATALOG), "known");
  assert.equal(matchService("ab", CATALOG), "unknown");
  assert.equal(matchService("", CATALOG), "unknown");
});

test("ขอเปลี่ยนเวลาไม่บอกบริการ: ใช้บริการของนัดเดิม", () => {
  const d = decide({ date: "2030-01-04", time: "10:00", is_change: true }, { service: FLU, date: "2030-01-03", time: "10:00:00" });
  assert.deepEqual([d.action, d.service], ["confirm", FLU]);
});

test("เทมเพลต: วันที่แบบไทย", () => {
  assert.equal(thaiWeekday("2030-01-03"), "พฤหัสบดี");
  assert.equal(thaiDate("2030-01-03"), "3 มกราคม");
  assert.equal(fillTemplate("ก{x}ข{y}", { x: "1" }), "ก1ข{y}");
  assert.equal(normalizeBookingTemplates({ confirm: "  " }).confirm, DEFAULT_BOOKING_TEMPLATES.confirm);
  assert.equal(normalizeBookingTemplates({ confirm: "ใหม่" }).confirm, "ใหม่");
});

test("เบอร์: ล่าสุด ไม่รวมเบอร์คลินิก", () => {
  assert.equal(extractPhone(["081-234-5678", "โทร 089 999 8888 นะ"]), "0899998888");
  assert.equal(extractPhone(["คลินิก 02-000-4586"]), null);
  assert.equal(extractPhone(["ราคา 1200 บาท"]), null);
});

test("ลบชื่อและเบอร์ของนัด ทุกรูปแบบขีดและช่องว่าง", () => {
  const out = maskBookingPii("ฉันสมชาย เบอร์ 081-234-5678 หรือ 0812345678", [{ name: "สมชาย", phone: "0812345678" }]);
  assert.equal(out, "ฉัน[ชื่อ] เบอร์ [เบอร์โทร] หรือ [เบอร์โทร]");
});

test("สัญญาณการจอง", () => {
  assert.equal(hasBookingSignal("ขอจองพรุ่งนี้"), true);
  assert.equal(hasBookingSignal("เปิดกี่โมง"), false);
});

test("ขอเลื่อน: เสนอวันถัดจากนัดเดิม", () => {
  const text = rescheduleText({ service: FLU, date: "2030-01-03", time: "10:00:00" }, DEFAULT_BOOKING_TEMPLATES, HOURS, NOW);
  assert.match(text, /วันพฤหัสบดีที่ 3 มกราคม เวลา 10\.00 น\./);
  assert.match(text, /วันศุกร์ที่ 4 มกราคม/);
});

test("push: ครั้งแรกทันที ซ้ำ 3 นาทีเฉพาะเวลาทำการ", () => {
  const ago = (m, from = NOW) => new Date(from - m * 60_000).toISOString();
  assert.equal(shouldPushBooking(null, HOURS, NOW), true);
  assert.equal(shouldPushBooking(ago(2), HOURS, NOW), false);
  assert.equal(shouldPushBooking(ago(3), HOURS, NOW), true);
  const night = Date.parse("2030-01-02T16:00:00Z"); // 23.00 น.
  assert.equal(shouldPushBooking(null, HOURS, night), true);
  assert.equal(shouldPushBooking(ago(30, night), HOURS, night), false);
});

// ---- ทั้งเส้นทาง ----
const SESSION = "11111111-1111-4111-8111-111111111111";
function setup() {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "auto" }, { key: "business_hours", value: HOURS }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: [{ id: "t", name: "นัดแล้ว", active: true }], tag_rules: [], tag_events: [], reply_examples: [],
    knowledge_items: [
      { id: "k1", category: "วัคซีน", title: "วัคซีนไข้หวัดใหญ่ 4 สายพันธุ์", content: "เข็มละ 390 บาท", active: true },
      { id: "k2", category: "บริการ", title: "บริการที่ยังไม่มี", content: CATALOG.unavailableText, active: true },
      { id: "k3", category: "ข้อมูลคลินิก", title: "เวลาทำการ", content: "พบแพทย์ได้ทุกวัน", active: true },
    ],
    lab_items: [{ code: "CBC", name_en: "CBC", name_th: "ความสมบูรณ์เลือด", active: true, cost: 987654 }],
    lab_packages: [],
    bookings: [],
    staff: [{ id: "agent", role: "agent", active: true, display_name: "B" }],
  });
  state.currentUser = { id: "agent", email: "b@test" };
}
beforeEach(setup);

const incoming = (text) => storeIncoming({ channelType: "web", externalId: SESSION, text });
const llm = (booking, intent = "booking", extra = {}) => {
  replies.next = { intent, booking, needs_human: false, suggested_tags: [], options: [{ text: "ร่างจาก AI", source: "knowledge", ref_ids: [], confidence: 0.6 }], ...extra };
};
async function ask(text, booking, intent, extra) {
  const { conversationId } = await incoming(text);
  llm(booking, intent, extra);
  const s = await generateSuggestions(conversationId, { now: NOW });
  return { conversationId, s };
}
const conv = () => state.tables.conversations[0];
const lastOut = () => state.tables.messages.filter((m) => m.direction === "out").at(-1);
const json = (method, body) => new Request("https://app.test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const TOMORROW = { service: FLU, date: "2030-01-03", time: "10:00", name: null };

test("ขอพรุ่งนี้ 10 โมง โหมด auto: ส่งคำยืนยัน บันทึกนัด และค้างในรอตอบ", async () => {
  const { conversationId, s } = await ask("ขอจองวัคซีนไข้หวัดใหญ่พรุ่งนี้ 10 โมงค่ะ", TOMORROW);
  assert.equal(s.options[0].confidence, 1);
  assert.equal(await tryAutoSend(conversationId, s.options, s.needs_human, s.id), true);
  const out = lastOut();
  assert.equal(out.sender_type, "ai");
  assert.equal(out.body, "ได้เลยค่ะ จองวัคซีนไข้หวัดใหญ่ให้วันพฤหัสบดีที่ 3 มกราคม เวลา 10.00 น. นะคะ 😊 มาถึงแจ้งชื่อที่เคาน์เตอร์ได้เลยค่ะ");
  const b = state.tables.bookings[0];
  assert.deepEqual([b.service, b.date, b.time, b.status, b.confirmed_message_id], [FLU, "2030-01-03", "10:00", "ai_confirmed", out.id]);
  assert.equal(conv().booking_pending, true);
  assert.equal(conv().last_direction, "out");
  assert.equal(isWaitingForReply(conv()), true);
  assert.deepEqual(tabsOf(conv()), ["open", "waiting"]);
});

test("AI ไม่ได้ตัดสิน: ตอบ AI ยืนยันเอง แต่อาทิตย์บ่าย 3 ไม่ถูกบันทึก", async () => {
  const { conversationId, s } = await ask("จองอาทิตย์บ่าย 3", { service: FLU, date: "2030-01-06", time: "15:00" });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  assert.match(lastOut().body, /ปิดทำการ.*วันอาทิตย์ที่ 6 มกราคม เวลา 11\.30 น\. หรือ วันจันทร์ที่ 7 มกราคม เวลา 15\.00 น\./);
  assert.equal(state.tables.bookings.length, 0);
  assert.ok(!conv().booking_pending);
});

test("ขอเวลาที่ผ่านแล้ว: ถามใหม่ ไม่บันทึก", async () => {
  const { conversationId, s } = await ask("จองวันนี้ 9 โมง", { service: FLU, date: "2030-01-02", time: "09:00" });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  assert.match(lastOut().body, /ผ่านไปแล้ว.*สะดวก/);
  assert.equal(state.tables.bookings.length, 0);
});

test("ขอ PRP เข่า: ไม่รับ ไม่บันทึก", async () => {
  const { conversationId, s } = await ask("ขอจอง PRP เข่าพรุ่งนี้ 10 โมง", { service: "PRP เข่า", date: "2030-01-03", time: "10:00" });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  assert.match(lastOut().body, /ยังไม่มีบริการ PRP เข่า/);
  assert.equal(state.tables.bookings.length, 0);
});

test("ไม่บอกวันเวลา: ถาม ไม่บันทึก", async () => {
  const { conversationId, s } = await ask("ขอจองวัคซีนไข้หวัดใหญ่", { service: FLU, date: null, time: null });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  assert.match(lastOut().body, /สะดวกมาวันไหน/);
  assert.equal(state.tables.bookings.length, 0);
});

test("บริการไม่อยู่ในฐานข้อมูล: ตอบตามเทมเพลต และให้คนตรวจต่อ", async () => {
  const { conversationId, s } = await ask("ขอจองทำฟัน", { service: "ทำฟัน", date: "2030-01-03", time: "10:00" });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  assert.equal(conv().needs_human, true);
  assert.equal(state.tables.bookings.length, 0);
  assert.ok(conversationId);
});

test("AI อ่านพรุ่งนี้ผิด: ยืนยันด้วยวันที่ที่โค้ดคำนวณ", async () => {
  const { conversationId, s } = await ask("ขอจองวัคซีนไข้หวัดใหญ่พรุ่งนี้ 10 โมง", { service: FLU, date: "2030-01-05", time: "11:00" });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  assert.deepEqual([state.tables.bookings[0].date, state.tables.bookings[0].time], ["2030-01-03", "10:00"]);
});

test("PRP เมื่อ AI ตอบ other และให้คนดู: โค้ดยังตอบว่าไม่รับได้", async () => {
  const { conversationId, s } = await ask("ขอจอง PRP เข่าพรุ่งนี้ 10 โมง", null, "other", { needs_human: true });
  assert.equal(s.needs_human, false);
  assert.equal(await tryAutoSend(conversationId, s.options, s.needs_human, s.id), true);
  assert.match(lastOut().body, /ยังไม่มีบริการ PRP/);
  assert.equal(state.tables.bookings.length, 0);
});

test("เวลาผ่านแล้ว แม้ AI ให้คนดู: ถามใหม่ได้เลย ส่วนการยืนยันยังต้องเคารพ", async () => {
  const { conversationId, s } = await ask("ขอจองเมื่อวาน 10 โมง", { service: FLU, date: "2030-01-01", time: "10:00" }, "booking", { needs_human: true });
  assert.equal(await tryAutoSend(conversationId, s.options, s.needs_human, s.id), true);
  assert.match(lastOut().body, /ผ่านไปแล้ว/);
});

test("พูดว่าจองพร้อมวันเวลา แม้ AI จัดเป็นเรื่องอื่น: ผ่านการตรวจของโค้ด", async () => {
  const { conversationId, s } = await ask("ขอจองเมื่อวาน 10 โมง", { service: FLU }, "other", { needs_human: true });
  assert.ok(s.options[0].booking);
  assert.equal(await tryAutoSend(conversationId, s.options, s.needs_human, s.id), true);
  assert.match(lastOut().body, /ผ่านไปแล้ว/);
});

test("ถามว่าต้องจองไหม: ไม่ใช่การจอง", async () => {
  const { s } = await ask("ต้องจองก่อนไหมคะ", null, "other");
  assert.equal(s.options[0].booking, undefined);
});

test("ชื่อวัคซีนไข้หวัดใหญ่ไม่ถูกนับเป็นเรื่องอาการ: เสนอเวลาได้เลย", async () => {
  const { conversationId, s } = await ask("ขอจองวัคซีนไข้หวัดใหญ่อาทิตย์บ่าย 3", { service: FLU }, "booking", { needs_human: true });
  assert.equal(await tryAutoSend(conversationId, s.options, s.needs_human, s.id), true);
  assert.match(lastOut().body, /ปิดทำการ/);
});

test("PRP ปนเรื่องด่วน: ยังให้คนดู", async () => {
  const { conversationId, s } = await ask("เจ็บหน้าอกมาก ขอจอง PRP", null, "other", { needs_human: true });
  assert.equal(s.needs_human, true);
  assert.equal(await tryAutoSend(conversationId, s.options, s.needs_human, s.id), false);
});

test("เรื่องที่ต้องให้คนดู: เป็นตัวเลือกแรกแต่ไม่ส่งเอง", async () => {
  const { conversationId, s } = await ask("เจ็บหน้าอกมาก ขอจองพรุ่งนี้", TOMORROW, "booking", { needs_human: true });
  assert.equal(await tryAutoSend(conversationId, s.options, s.needs_human, s.id), false);
  assert.equal(state.tables.bookings.length, 0);
});

test("intent other: ไม่มีตัวเลือกจอง", async () => {
  const { s } = await ask("ต้องนัดก่อนไหมคะ", null, "other");
  assert.equal(s.options[0].text, "ร่างจาก AI");
  assert.equal(s.options[0].booking, undefined);
});

test("โหมดผู้ช่วย: เจ้าหน้าที่กดส่งตัวเลือกแรกแล้วบันทึกนัด และไม่เรียนรู้", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้ 10 โมง", TOMORROW);
  assert.equal(state.tables.bookings.length, 0, "ยังไม่ส่ง ต้องยังไม่บันทึก");
  assert.ok(s.options[0].booking);
  const res = await sendRoute.POST(json("POST", { text: s.options[0].text, suggestionId: s.id, chosenIndex: 0 }), ctx(conversationId));
  assert.equal(res.status, 200);
  assert.equal(state.tables.bookings.length, 1);
  assert.equal(state.tables.reply_examples.length, 0);
});

test("คำแนะนำค้างจนเวลาผ่าน: กดส่งไม่ได้", async () => {
  const { conversationId, s } = await ask("ขอจองค่ะ", { service: FLU, date: "2030-01-03", time: "10:00" });
  state.tables.suggestions.at(-1).options[0].booking.date = "2020-01-02";
  const res = await sendRoute.POST(json("POST", { text: "x", suggestionId: s.id, chosenIndex: 0 }), ctx(conversationId));
  assert.equal(res.status, 409);
  assert.equal(state.tables.bookings.length, 0);
});

test("ชื่อที่ AI แต่งไม่ถูกเก็บ ใช้ชื่อในแผงลูกค้าแทน และเบอร์ดึงด้วยโค้ด", async () => {
  const { conversationId } = await incoming("ขอจองพรุ่งนี้ เบอร์ 081-234-5678");
  state.tables.contacts[0].display_name = "คุณเอ";
  llm({ ...TOMORROW, name: "ชื่อที่แต่งขึ้น" });
  const s = await generateSuggestions(conversationId, { now: NOW });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  const b = state.tables.bookings[0];
  assert.deepEqual([b.name, b.phone], ["คุณเอ", "0812345678"]);
  assert.doesNotMatch(calls.lastPrompt, /081-234-5678|0812345678/, "AI ไม่ควรเห็นเบอร์");
});

test("ชื่อที่ลูกค้าบอกเองถูกเก็บ และรอบถัดไปห้ามส่งให้ AI", async () => {
  const { conversationId } = await incoming("ขอจองพรุ่งนี้ ชื่อมาลีวรรณ");
  llm({ ...TOMORROW, name: "มาลีวรรณ" });
  const s = await generateSuggestions(conversationId, { now: NOW });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  assert.equal(state.tables.bookings[0].name, "มาลีวรรณ");

  await incoming("ขอถามราคาหน่อยค่ะ");
  llm(null, "other");
  await generateSuggestions(conversationId, { now: NOW });
  assert.doesNotMatch(calls.lastPrompt, /มาลีวรรณ/);
  assert.match(calls.lastPrompt, /\[ชื่อ\]/);
});

test("ชื่อและเบอร์ไม่เข้า reply_examples จากการตอบของเจ้าหน้าที่", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้ ชื่อมาลีวรรณ 081-234-5678", { ...TOMORROW, name: "มาลีวรรณ" });
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  await incoming("มาลีวรรณ ต้องเตรียมอะไรไหมคะ");
  await sendReply({ conversationId, textTh: "คุณมาลีวรรณ ไม่ต้องเตรียมอะไรค่ะ", senderType: "staff", senderId: "agent" });
  const stored = JSON.stringify(state.tables.reply_examples);
  assert.equal(state.tables.reply_examples.length, 1);
  assert.doesNotMatch(stored, /มาลีวรรณ|081/);
});

test("ไม่มีต้นทุนในรายการบริการที่ส่งให้ AI", async () => {
  await ask("จอง", TOMORROW);
  assert.ok(!calls.lastPrompt.includes("987654"));
});

test("ยืนยันแล้วลูกค้าขอบคุณ: ไม่ตอบซ้ำ", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  await incoming("ขอบคุณค่ะ");
  const before = calls.chat;
  const again = await generateSuggestions(conversationId, { now: NOW });
  assert.equal(again.skipped, "no_reply_needed");
  assert.equal(calls.chat, before);
});

test("ขอเปลี่ยนเวลา: ตรวจใหม่ ยืนยันเวลาใหม่ และอัปเดตรายการเดิม", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  await incoming("ขอเปลี่ยนเป็นศุกร์บ่าย 2 ค่ะ");
  llm({ service: FLU, date: "2030-01-04", time: "14:00", is_change: true });
  const s2 = await generateSuggestions(conversationId, { now: NOW });
  await tryAutoSend(conversationId, s2.options, s2.needs_human, s2.id);
  assert.equal(state.tables.bookings.length, 1);
  assert.deepEqual([state.tables.bookings[0].date, state.tables.bookings[0].time], ["2030-01-04", "14:00"]);
  assert.match(lastOut().body, /วันศุกร์ที่ 4 มกราคม เวลา 14\.00/);
});

test("ขอเปลี่ยนเป็นเวลาที่ปิด: เสนอเวลา นัดเดิมไม่เปลี่ยน", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  await incoming("ขอเปลี่ยนเป็นอาทิตย์บ่าย 3");
  llm({ service: FLU, date: "2030-01-06", time: "15:00", is_change: true });
  const s2 = await generateSuggestions(conversationId, { now: NOW });
  await tryAutoSend(conversationId, s2.options, s2.needs_human, s2.id);
  assert.equal(state.tables.bookings[0].date, "2030-01-03");
  assert.match(lastOut().body, /ปิดทำการ/);
});

test("ลงนัดแล้วลูกค้าขอเปลี่ยน: กลับไปยังไม่ลงนัด และเอาแท็กนัดแล้วออก", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  await recordRoute.POST(json("POST"), ctx(state.tables.bookings[0].id));
  assert.ok(conv().tags.includes("นัดแล้ว"));
  await incoming("ขอเปลี่ยนเป็นศุกร์ 10 โมง");
  llm({ service: FLU, date: "2030-01-04", time: "10:00", is_change: true });
  const s2 = await generateSuggestions(conversationId, { now: NOW });
  await tryAutoSend(conversationId, s2.options, s2.needs_human, s2.id);
  const b = state.tables.bookings[0];
  assert.deepEqual([b.status, b.recorded_at, conv().booking_pending], ["ai_confirmed", null, true]);
  assert.ok(!conv().tags.includes("นัดแล้ว"));
});

test("คำตอบติดดาวไม่ข้ามการตรวจการจอง", async () => {
  const { conversationId } = await incoming("ขอจองวัคซีนพรุ่งนี้");
  state.matchExamples = [{ id: "e", question: "ขอจองวัคซีนพรุ่งนี้", answer: "ได้ค่ะ มาได้เลย", starred: true, use_count: 9, created_at: "2026-01-01T00:00:00Z", similarity: 0.99 }];
  llm(TOMORROW);
  const before = calls.chat;
  const s = await generateSuggestions(conversationId, { now: NOW });
  state.matchExamples = [];
  assert.equal(calls.chat, before + 1);
  assert.ok(s.options[0].booking);
});

test("กดเสร็จแล้วก่อนลงนัดไม่ได้ ลงนัดแล้วกดได้ เสียงเตือนหยุด", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  const blocked = await closeRoute.POST(json("POST"), ctx(conversationId));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "ลงนัดก่อน");
  assert.equal(conv().status, "open");

  assert.equal((await recordRoute.POST(json("POST"), ctx(state.tables.bookings[0].id))).status, 200);
  const b = state.tables.bookings[0];
  assert.deepEqual([b.status, b.recorded_by], ["recorded", "agent"]);
  assert.ok(b.recorded_at);
  assert.equal(conv().booking_pending, false, "booking_pending ที่หน้าเว็บใช้เล่นเสียงต้องดับ");
  assert.ok(conv().tags.includes("นัดแล้ว"));
  assert.equal(isWaitingForReply(conv()), false);
  assert.equal((await closeRoute.POST(json("POST"), ctx(conversationId))).status, 200);
});

test("กดลงนัดซ้ำ: 409", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  const id = state.tables.bookings[0].id;
  await recordRoute.POST(json("POST"), ctx(id));
  assert.equal((await recordRoute.POST(json("POST"), ctx(id))).status, 409);
});

test("ย้ายไปเสร็จแล้วอัตโนมัติ: ข้ามแชทที่ยังไม่ลงนัด", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  conv().needs_human = false;
  assert.equal(await autoCloseQuietChats(Date.now() + 100 * 3_600_000), 0);
  assert.equal(conv().status, "open");
  await recordRoute.POST(json("POST"), ctx(state.tables.bookings[0].id));
  assert.equal(await autoCloseQuietChats(Date.now() + 100 * 3_600_000), 1);
});

test("เลื่อน/ยกเลิก: สร้างข้อความอย่างเดียว ส่งแล้วจึงยกเลิก", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  const id = state.tables.bookings[0].id;
  const outBefore = state.tables.messages.filter((m) => m.direction === "out").length;
  const { text } = await (await draftRoute.POST(json("POST"), ctx(id))).json();
  assert.match(text, /ขออภัย/);
  assert.equal(state.tables.messages.filter((m) => m.direction === "out").length, outBefore, "ต้องไม่ส่งเอง");
  assert.equal(state.tables.bookings[0].status, "ai_confirmed");

  assert.equal((await sendRoute.POST(json("POST", { text, cancelBookingId: id }), ctx(conversationId))).status, 200);
  assert.equal(state.tables.bookings[0].status, "cancelled");
  assert.equal(conv().booking_pending, false);
  assert.equal(state.tables.reply_examples.length, 0);
});

test("ยกเลิกด้วย id ของแชทอื่นไม่มีผล", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  state.tables.bookings.push({ id: "other", conversation_id: "x", status: "ai_confirmed" });
  await sendRoute.POST(json("POST", { text: "ข้อความ", cancelBookingId: "other" }), ctx(conversationId));
  assert.equal(state.tables.bookings.find((b) => b.id === "other").status, "ai_confirmed");
});

test("แก้การ์ด: ค่าที่ถูกต้องบันทึก ค่าเสียไม่ผ่าน", async () => {
  const { conversationId, s } = await ask("ขอจองพรุ่งนี้", TOMORROW);
  await tryAutoSend(conversationId, s.options, s.needs_human, s.id);
  const id = state.tables.bookings[0].id;
  assert.equal((await bookingRoute.PATCH(json("PATCH", { date: "2030-01-05", time: "9:00", name: "ก", phone: "081" }), ctx(id))).status, 200);
  assert.deepEqual([state.tables.bookings[0].date, state.tables.bookings[0].time, state.tables.bookings[0].name], ["2030-01-05", "09:00", "ก"]);
  assert.equal((await bookingRoute.PATCH(json("PATCH", { date: "x" }), ctx(id))).status, 400);
  assert.equal((await bookingRoute.PATCH(json("PATCH", { service: " " }), ctx(id))).status, 400);
  assert.equal((await bookingRoute.PATCH(json("PATCH", { name: "ก" }), ctx("ไม่มี"))).status, 404);
});

test("ไม่ล็อกอินจัดการนัดไม่ได้", async () => {
  state.currentUser = null;
  assert.equal((await recordRoute.POST(json("POST"), ctx("x"))).status, 401);
  assert.equal((await bookingRoute.PATCH(json("PATCH", {}), ctx("x"))).status, 401);
  assert.equal((await draftRoute.POST(json("POST"), ctx("x"))).status, 401);
});

test("push: ส่งเฉพาะที่ถึงเวลา ไม่มีข้อมูลส่วนตัว ลบเครื่องที่ยกเลิกแล้ว", async () => {
  state.tables.bookings = [{ id: "b1", conversation_id: "c", name: "มาลี", phone: "0812345678", service: FLU, status: "ai_confirmed", last_push_at: null }];
  state.tables.push_subscriptions = [{ endpoint: "https://a", p256dh: "p", auth: "x" }, { endpoint: "https://gone", p256dh: "p", auth: "x" }];
  const sentPayloads = [];
  const send = async (sub, payload) => {
    if (sub.endpoint === "https://gone") throw Object.assign(new Error("gone"), { statusCode: 410 });
    sentPayloads.push(payload);
  };
  assert.equal(await pushPendingBookings(NOW, send), 1);
  assert.doesNotMatch(sentPayloads[0], /มาลี|081|วัคซีน/);
  assert.deepEqual(state.tables.push_subscriptions.map((s) => s.endpoint), ["https://a"]);
  assert.equal(await pushPendingBookings(NOW + 60_000, send), 0, "ยังไม่ครบ 3 นาที");
  assert.equal(await pushPendingBookings(NOW + 180_000, send), 1);
  state.tables.bookings[0].status = "recorded";
  assert.equal(await pushPendingBookings(NOW + 360_000, send), 0, "ลงนัดแล้วหยุด");
});

test("migration: กันที่ฐานข้อมูล และคนทั่วไปเขียนไม่ได้", () => {
  const sql = readFileSync("supabase/migrations/023_bookings.sql", "utf8");
  assert.match(sql, /revoke insert, update, delete on bookings from anon, authenticated/);
  assert.match(sql, /raise exception 'ลงนัดก่อน'/);
  assert.match(sql, /status in \('ai_confirmed', 'recorded', 'cancelled'\)/);
});
