// ทดสอบการนำเข้าประวัติ LINE ด้วยข้อมูลจำลองทั้งหมด: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { sendReply } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const {
  ambiguousNames, buildExamplePairs, findMassMessages, groupRooms, parseLineHistory, parseThaiDate, parseThaiTime, summarizeImport,
} = await import("../src/lib/line-import.ts");
const { importHash, importRoom, matchContacts } = await import("../src/lib/line-import-store.ts");
const batches = await import("../src/app/api/imports/line/route.ts");
const previewRoute = await import("../src/app/api/imports/line/preview/route.ts");
const roomRoute = await import("../src/app/api/imports/line/room/route.ts");

const at = (min) => new Date(Date.parse("2026-05-01T03:00:00Z") + min * 60_000).toISOString();
const msg = (room, sender, min, text, extra = {}) => ({ room, sender, sent_at: at(min), text, ...extra });
const roomOf = (name, ...messages) => groupRooms(messages.map((m) => ({ room: name, ...m })))[0];
const pairs = (room, mass = new Set()) => buildExamplePairs(room, mass);

test("อ่าน jsonl: นับแถวเสีย ไม่ล้ม", () => {
  const content = [JSON.stringify(msg("ห้องจำลอง", "customer", 0, "สวัสดี")), "ไม่ใช่ json", JSON.stringify({ room: "x" }), "", JSON.stringify(msg("ห้อง", "robot", 0, "x"))].join("\n");
  const { records, invalid } = parseLineHistory(content);
  assert.equal(records.length, 1);
  assert.equal(invalid, 3);
});

// รูปแบบแถวละห้อง
const REF = "2026-11-02";
const ROOM = (over = {}, messages = []) => JSON.stringify({ line_user_id: `U${"a".repeat(32)}`, display_name: "ห้องจำลอง", messages, ...over });
const META = JSON.stringify({ _meta: { source: "chat.line.biz", reference_date: REF, rooms: 1, messages: 2, list_complete: true, errors: [] } });
const FM = (role, date, time, text, extra = {}) => ({ role, date, time, text, type: "text", id: String(Math.random()), read: false, staff: null, ...extra });

test("แถวละห้อง: อ่าน _meta และแปลงผู้ส่ง", () => {
  const p = parseLineHistory([META, ROOM({}, [FM("customer", "27 ต.ค. (อ.)", "14.05 น.", "ถามจำลอง"), FM("clinic", "27 ต.ค. (อ.)", "14.06 น.", "ตอบจำลองค่ะ")])].join("\n"));
  assert.equal(p.meta.rooms, 1);
  assert.deepEqual(p.records.map((r) => [r.room, r.room_id.length, r.sender, r.sent_at]), [
    ["ห้องจำลอง", 33, "customer", "2026-10-27T07:05:00.000Z"],
    ["ห้องจำลอง", 33, "official", "2026-10-27T07:06:00.000Z"],
  ]);
});

for (const [value, want] of [["27 ต.ค. (อ.)", "2026-10-27"], ["1 พ.ย. (อา.)", "2026-11-01"], ["2 พ.ย. (จ.)", "2026-11-02"], ["28 ธ.ค. (จ.)", "2025-12-28"], ["เมื่อวาน", "2026-11-01"], ["วันนี้", "2026-11-02"], ["ไม่รู้", null], ["5 ม.ก. (จ.)", null]]) {
  test(`วันที่ไทย "${value}": ${want}`, () => assert.equal(parseThaiDate(value, REF), want));
}
test("เวลาไทย", () => {
  assert.equal(parseThaiTime("9.05 น."), "09:05");
  assert.equal(parseThaiTime("24.00 น."), null);
  assert.equal(parseThaiTime(null), null);
});

test("แถวละห้อง: system ไม่นำเข้า auto ไม่เป็นคำตอบ เวลาว่างใช้ของก่อนหน้า นาทีเดียวกันเรียงตามลำดับ", () => {
  const p = parseLineHistory([META, ROOM({}, [
    { role: "system", date: "27 ต.ค. (อ.)", text: "ระบบจำลอง" },
    FM("customer", "27 ต.ค. (อ.)", "14.05 น.", "ถามจำลอง"),
    FM("auto", "27 ต.ค. (อ.)", "14.05 น.", "ข้อความอัตโนมัติจำลอง"),
    FM("clinic", "27 ต.ค. (อ.)", null, "ตอบจำลองค่ะ"),
  ])].join("\n"));
  assert.equal(p.estimatedTimes, 1);
  const room = groupRooms(p.records)[0];
  assert.equal(room.messages.length, 3);
  assert.deepEqual(room.messages.map((m) => m.sent_at.slice(17, 19)), ["00", "01", "02"]);
  assert.equal(new Set(room.messages.map((m) => m.sent_at)).size, 3);
  const pairs_ = buildExamplePairs(room, new Set());
  assert.deepEqual(pairs_.map((x) => x.answer), ["ตอบจำลองค่ะ"]);
});

test("แถวละห้อง: เรียงตามลำดับในไฟล์ แม้เวลาย้อน", () => {
  const p = parseLineHistory([META, ROOM({}, [FM("customer", "27 ต.ค. (อ.)", "14.10 น.", "ถามจำลอง"), FM("clinic", "27 ต.ค. (อ.)", "14.01 น.", "ตอบจำลองค่ะ")])].join("\n"));
  assert.equal(buildExamplePairs(groupRooms(p.records)[0], new Set()).length, 1);
});

test("แถวละห้อง: id ซ้ำนับและข้าม ชื่อว่างใช้ชื่อแทน แถววันที่เสียนับเป็นแถวเสีย", () => {
  const dup = FM("customer", "27 ต.ค. (อ.)", "14.05 น.", "ถามจำลอง");
  const p = parseLineHistory([META, ROOM({ display_name: "" }, [dup, dup, FM("customer", "ไม่รู้", "14.05 น.", "x")])].join("\n"));
  assert.equal(p.duplicates, 1);
  assert.equal(p.invalid, 1);
  assert.equal(p.records.length, 1);
  assert.match(p.records[0].room, /^ลูกค้าไม่มีชื่อ /);
});

test("แถวละห้อง: อ่านซ้ำได้ hash เดิม กันซ้ำได้", () => {
  const file = [META, ROOM({}, [FM("customer", "27 ต.ค. (อ.)", null, "ถามจำลอง")])].join("\n");
  const [a, b] = [parseLineHistory(file), parseLineHistory(file)];
  assert.equal(importHash(a.records[0].room_id, a.records[0]), importHash(b.records[0].room_id, b.records[0]));
});

test("ข้อความระบบไม่นำเข้า และเรียงตามเวลา", () => {
  const r = groupRooms([msg("ก", "official", 5, "ตอบ"), msg("ก", "customer", 1, "ถาม"), msg("ก", "official", 2, "เข้าร่วมแล้ว", { type: "system" })])[0];
  assert.deepEqual(r.messages.map((m) => m.text), ["ถาม", "ตอบ"]);
});

test("ชื่อห้องซ้ำต่าง room_id: ถือว่ากำกวม", () => {
  const rooms = groupRooms([msg("ซ้ำ", "customer", 0, "ก", { room_id: "1" }), msg("ซ้ำ", "customer", 1, "ข", { room_id: "2" }), msg("เดียว", "customer", 2, "ค")]);
  assert.equal(rooms.length, 3);
  assert.deepEqual([...ambiguousNames(rooms)], ["ซ้ำ"]);
});

test("คู่คำถามคำตอบ: รวมข้อความลูกค้าต่อเนื่อง และคำตอบต่อเนื่อง", () => {
  const p = pairs(roomOf("ก", msg("ก", "customer", 0, "สวัสดี"), msg("ก", "customer", 1, "ฉีดวัคซีนไหม"), msg("ก", "official", 2, "ฉีดได้ค่ะ"), msg("ก", "official", 3, "เปิดทุกวันค่ะ")));
  assert.equal(p.length, 1);
  assert.equal(p[0].question, "สวัสดี\nฉีดวัคซีนไหม");
  assert.equal(p[0].answer, "ฉีดได้ค่ะ\nเปิดทุกวันค่ะ");
});

test("สองรอบคำถามได้สองคู่", () => {
  const p = pairs(roomOf("ก", msg("ก", "customer", 0, "ถามหนึ่ง"), msg("ก", "official", 1, "ตอบหนึ่งค่ะ"), msg("ก", "customer", 2, "ถามสอง"), msg("ก", "official", 3, "ตอบสองค่ะ")));
  assert.deepEqual(p.map((x) => x.question), ["ถามหนึ่ง", "ถามสอง"]);
});

test("ข้ามคำตอบสั้นกว่า 4 ตัวอักษร", () => {
  assert.equal(pairs(roomOf("ก", msg("ก", "customer", 0, "ถามหน่อย"), msg("ก", "official", 1, "ได้"))).length, 0);
  assert.equal(pairs(roomOf("ก", msg("ก", "customer", 0, "ถามหน่อย"), msg("ก", "official", 1, "ได้ค่ะ"))).length, 1);
});

for (const type of ["sticker", "image", "video"]) {
  test(`ข้าม ${type} ทั้งสองฝั่ง`, () => {
    assert.equal(pairs(roomOf("ก", msg("ก", "customer", 0, "", { type }), msg("ก", "official", 1, "ได้เลยค่ะ"))).length, 0);
    assert.equal(pairs(roomOf("ก", msg("ก", "customer", 0, "ถามหน่อย"), msg("ก", "official", 1, "", { type }))).length, 0);
  });
}

for (const origin of ["broadcast", "auto_reply"]) {
  test(`${origin} ไม่เป็นคำตอบ และไม่ทำให้คำถามหาย`, () => {
    const p = pairs(roomOf("ก", msg("ก", "customer", 0, "ถามหน่อย"), msg("ก", "official", 1, "ขอบคุณที่ติดต่อมา", { origin }), msg("ก", "official", 2, "พนักงานตอบค่ะ")));
    assert.equal(p[0].answer, "พนักงานตอบค่ะ");
  });
}

test("ข้อความเก่าเกิน 24 ชม. ไม่จับคู่", () => {
  assert.equal(pairs(roomOf("ก", msg("ก", "customer", 0, "ถามหน่อย"), msg("ก", "official", 25 * 60, "ตอบช้าค่ะ"))).length, 0);
});

test("scrubPII และลบชื่อห้องออกจากคู่", () => {
  const p = pairs(roomOf("คุณสมมติ", msg("คุณสมมติ", "customer", 0, "ฉันคุณสมมติ เบอร์ 081-234-5678"), msg("คุณสมมติ", "official", 1, "รับทราบค่ะคุณสมมติ")));
  assert.doesNotMatch(p[0].question + p[0].answer, /คุณสมมติ|081/);
  assert.match(p[0].question, /\[เบอร์โทร\]/);
});

test("ตรวจบรอดแคสต์: ส่งพร้อมกัน 3 ห้อง", () => {
  const rooms = groupRooms(["ก", "ข", "ค"].map((n, i) => msg(n, "official", i, "โปรโมชันเดือนนี้")));
  assert.ok(findMassMessages(rooms).has("โปรโมชันเดือนนี้"));
});

test("คำตอบเหมือนกัน 2 ห้องหรือคำสั้นคนละเวลา: ไม่ใช่บรอดแคสต์", () => {
  const rooms = groupRooms([...["ก", "ข", "ค", "ง", "จ"].map((n, i) => msg(n, "official", i * 600, "ได้ค่ะ")), msg("ฉ", "official", 0, "เปิดกี่โมงตอบแบบนี้"), msg("ช", "official", 1, "เปิดกี่โมงตอบแบบนี้")]);
  assert.equal(findMassMessages(rooms).size, 0);
});

test("ข้อความทักทายยาวเหมือนกัน 5 ห้องคนละเวลา: ข้าม", () => {
  const text = "ขอบคุณที่เพิ่มเราเป็นเพื่อน ยินดีให้บริการค่ะ";
  const rooms = groupRooms(["ก", "ข", "ค", "ง", "จ"].map((n, i) => msg(n, "official", i * 600, text)));
  const mass = findMassMessages(rooms);
  assert.ok(mass.has(text));
  assert.equal(pairs(roomOf("ก", msg("ก", "customer", 0, "ถามหน่อย"), msg("ก", "official", 1, text)), mass).length, 0);
});

test("สรุปไฟล์", () => {
  const s = summarizeImport(groupRooms([msg("ก", "customer", 0, "ถามหน่อย"), msg("ก", "official", 1, "ตอบค่ะนะ"), msg("ข", "customer", 60, "สวัสดี")]));
  assert.deepEqual([s.rooms, s.messages, s.pairs, s.from, s.to], [2, 3, 1, at(0), at(60)]);
});

// ---- ลงฐานข้อมูล ----
const OLD = "2026-05-01T03:00:00.000Z";
function setup() {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "line", type: "line", ai_mode: null, enabled: true, created_at: nextTime() }, { id: "web", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [
      { id: "c1", channel_id: "line", external_id: "U1", display_name: "ลูกค้าจำลอง", language: "th" },
      { id: "c2", channel_id: "line", external_id: "U2", display_name: "ชื่อซ้ำจำลอง", language: "th" },
      { id: "c3", channel_id: "line", external_id: "U3", display_name: "ชื่อซ้ำจำลอง", language: "th" },
      { id: "c4", channel_id: "web", external_id: "W1", display_name: "ชื่อเว็บจำลอง", language: "th" },
    ],
    conversations: [
      { id: "conv1", contact_id: "c1", channel_id: "web", status: "open", tags: [], unread_count: 0, needs_human: false, last_direction: "out", waiting_since: null },
    ],
    messages: [{ id: "real1", conversation_id: "conv1", direction: "out", sender_type: "staff", body: "ข้อความจริงในระบบ", created_at: "2026-10-01T03:00:00.000Z" }],
    reply_examples: [], import_batches: [{ id: "b1", rooms: 0, messages_imported: 0, examples_imported: 0 }], tags: [], tag_rules: [], tag_events: [], bookings: [],
    knowledge_items: [], lab_items: [], lab_packages: [],
    staff: [{ id: "admin", role: "admin", active: true, display_name: "A" }, { id: "agent", role: "agent", active: true, display_name: "B" }],
  });
  state.currentUser = { id: "admin", email: "a@test" };
}
beforeEach(setup);

const SAMPLE = roomOf("ลูกค้าจำลอง", msg("ลูกค้าจำลอง", "customer", 0, "วัคซีนราคาเท่าไหร่"), msg("ลูกค้าจำลอง", "official", 1, "เข็มละ 111 บาทค่ะ"), msg("ลูกค้าจำลอง", "customer", 2, "", { type: "sticker" }));
const imported = () => state.tables.messages.filter((m) => m.imported);
const conv = () => state.tables.conversations[0];

test("จับคู่ด้วยชื่อ: ซ้ำหรือไม่พบให้ข้าม เฉพาะช่องทาง LINE", async () => {
  const m = await matchContacts(["ลูกค้าจำลอง", "ชื่อซ้ำจำลอง", "ไม่มีชื่อนี้", "ชื่อเว็บจำลอง"]);
  assert.deepEqual([...m.keys()], ["ลูกค้าจำลอง"]);
});

test("นำเข้า: ติด imported ใช้เวลาเดิม สติกเกอร์เป็นตัวยึด", async () => {
  const r = await importRoom("b1", SAMPLE, new Set(), true);
  assert.deepEqual([r.messages, r.examples, r.matched], [3, 1, true]);
  assert.ok(imported().every((m) => m.imported && m.import_hash && m.import_batch_id === "b1" && m.sender_id === undefined));
  assert.equal(imported()[0].created_at, OLD);
  assert.equal(imported()[2].body, "[สติกเกอร์]");
});

test("ไม่เข้ารอตอบ: ข้อความนำเข้าไม่เปลี่ยนสถานะคิว", async () => {
  const before = JSON.stringify(conv());
  await importRoom("b1", SAMPLE, new Set(), true);
  assert.equal(JSON.stringify(conv()), before);
});

test("ข้อความใหม่กว่าข้อความแรกในระบบไม่นำเข้า กันซ้ำกับ webhook", async () => {
  const room = roomOf("ลูกค้าจำลอง", { sender: "customer", sent_at: "2026-10-05T03:00:00.000Z", text: "ข้อความใหม่จาก webhook" });
  assert.equal((await importRoom("b1", room, new Set(), true)).messages, 0);
});

test("นำเข้าซ้ำ: ไม่เพิ่มแถว ไม่เรียก embedding ซ้ำ", async () => {
  await importRoom("b1", SAMPLE, new Set(), true);
  const embeds = calls.embed;
  const r = await importRoom("b1", SAMPLE, new Set(), true);
  assert.deepEqual([r.messages, r.examples], [0, 0]);
  assert.equal(imported().length, 3);
  assert.equal(state.tables.reply_examples.length, 1);
  assert.equal(calls.embed, embeds);
});

test("hash ขึ้นกับห้อง เวลา ผู้ส่ง ข้อความ", () => {
  const m = msg("ก", "customer", 0, "ถาม");
  assert.equal(importHash("ก", m), importHash("ก", { ...m, sent_at: new Date(m.sent_at).toISOString() }));
  assert.notEqual(importHash("ก", m), importHash("ข", m));
  assert.notEqual(importHash("ก", m), importHash("ก", { ...m, sender: "official" }));
  assert.notEqual(importHash("ก", m), importHash("ก", { ...m, text: "อื่น" }));
});

test("คู่คำตอบตั้ง source line_import", async () => {
  await importRoom("b1", SAMPLE, new Set(), true);
  const e = state.tables.reply_examples[0];
  assert.deepEqual([e.source, e.import_batch_id, e.answer], ["line_import", "b1", "เข็มละ 111 บาทค่ะ"]);
  assert.equal(e.created_at, at(1));
});

test("จับคู่ไม่ได้: ยังเรียนรู้คู่คำตอบ แต่ไม่ลงประวัติแชท", async () => {
  const room = roomOf("ไม่มีชื่อนี้", msg("ไม่มีชื่อนี้", "customer", 0, "ถามหน่อย"), msg("ไม่มีชื่อนี้", "official", 1, "ตอบค่ะนะ"));
  const r = await importRoom("b1", room, new Set(), true);
  assert.deepEqual([r.messages, r.examples, r.matched], [0, 1, false]);
});

test("ไม่อนุญาตประวัติ เช่น ชื่อกำกวมในไฟล์: ไม่ลงประวัติแม้ชื่อตรงในระบบ", async () => {
  const r = await importRoom("b1", SAMPLE, new Set(), false);
  assert.equal(r.messages, 0);
});

test("ตัวนับชุดนำเข้า", async () => {
  await importRoom("b1", SAMPLE, new Set(), true);
  const b = state.tables.import_batches[0];
  assert.deepEqual([b.rooms, b.messages_imported, b.examples_imported], [1, 3, 1]);
});

test("AI ไม่เห็นข้อความนำเข้า และไม่นับตัวเลขจากคำตอบนำเข้าเป็นแหล่งยืนยัน", async () => {
  await importRoom("b1", SAMPLE, new Set(), true);
  const example = state.tables.reply_examples[0];
  const conversationId = "conv1";
  state.tables.messages.push({ id: "in-now", conversation_id: conversationId, direction: "in", sender_type: "customer", body: "วัคซีนราคาเท่าไหร่คะ", created_at: "2026-10-02T03:00:00.000Z" });
  state.matchExamples = [{ id: example.id, question: example.question, answer: example.answer, starred: false, use_count: 0, created_at: at(1), similarity: 0.9 }];
  replies.next = { needs_human: false, suggested_tags: [], options: [{ text: "เข็มละ 111 บาทค่ะ", source: "example", ref_ids: [], confidence: 0.95 }] };
  const s = await generateSuggestions(conversationId);
  state.matchExamples = [];
  assert.ok(s.options[0].confidence <= 0.5, "ราคาเก่าจากการนำเข้าต้องถูกจับ");
  assert.doesNotMatch(calls.lastPrompt.split("## ประวัติแชทล่าสุด")[1], /เข็มละ 111/);
});

test("ไม่คิดคะแนนจากข้อความนำเข้า: เวลาเริ่มนับมาจากข้อความจริง", async () => {
  await importRoom("b1", SAMPLE, new Set(), true);
  state.tables.messages.push({ id: "in-real", conversation_id: "conv1", direction: "in", sender_type: "customer", body: "ข้อความจริงจากลูกค้าคนนี้", created_at: new Date(Date.now() - 60_000).toISOString() });
  await sendReply({ conversationId: "conv1", textTh: "ตอบข้อความจริงยาวพอให้คิดคะแนนค่ะ", senderType: "staff", senderId: "agent" });
  const events = state.tables.response_events ?? [];
  assert.equal(events.length, 1);
  assert.equal(events[0].inbound_message_id, "in-real");
});

test("ซ่อนทั้งชุด: คำตอบซ่อน ประวัติยังอยู่ และเปิดคืนได้", async () => {
  await importRoom("b1", SAMPLE, new Set(), true);
  state.tables.reply_examples[0].active = true;
  const patch = (hidden) => batches.PATCH(new Request("https://a.test/x", { method: "PATCH", body: JSON.stringify({ id: "b1", hidden }) }));
  assert.equal((await patch(true)).status, 200);
  assert.equal(state.tables.reply_examples[0].active, false);
  assert.ok(state.tables.import_batches[0].hidden_at);
  assert.equal(imported().length, 3);
  await patch(false);
  assert.equal(state.tables.reply_examples[0].active, true);
  assert.equal(state.tables.import_batches[0].hidden_at, null);
});

const post = (body) => new Request("https://a.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("API ห้อง: ข้อมูลเสียไม่ผ่าน และนำเข้าได้", async () => {
  assert.equal((await roomRoute.POST(post({ batchId: "b1", room: "ก", messages: [{ room: "ก" }] }))).status, 400);
  assert.equal((await roomRoute.POST(post({ batchId: "ไม่มี", room: "ก", messages: [] }))).status, 404);
  const res = await roomRoute.POST(post({ batchId: "b1", key: "x", room: "ลูกค้าจำลอง", messages: SAMPLE.messages, mass: [], historyAllowed: true }));
  assert.deepEqual(await res.json(), { messages: 3, examples: 1, matched: true, archived: false });
});

test("API สรุป: คืนเฉพาะชื่อที่จับคู่ได้", async () => {
  const j = await (await previewRoute.POST(post({ names: ["ลูกค้าจำลอง", "ไม่มี"] }))).json();
  assert.deepEqual(j.matched, ["ลูกค้าจำลอง"]);
  assert.equal((await previewRoute.POST(post({ names: "x" }))).status, 400);
});

for (const [name, call] of [
  ["ดูชุด", () => batches.GET()],
  ["เริ่มนำเข้า", () => batches.POST(post({}))],
  ["ซ่อนชุด", () => batches.PATCH(post({ id: "b1", hidden: true }))],
  ["สรุป", () => previewRoute.POST(post({ names: [] }))],
  ["นำเข้าห้อง", () => roomRoute.POST(post({ batchId: "b1", room: "ก", messages: [] }))],
]) {
  test(`agent ${name}: 403`, async () => {
    state.currentUser = { id: "agent", email: "b@test" };
    assert.equal((await call()).status, 403);
  });
}

test("migration: trigger คิวไม่สนใจข้อความนำเข้า", () => {
  const sql = readFileSync("supabase/migrations/024_line_import.sql", "utf8");
  assert.match(sql, /tg_op = 'INSERT' and new\.imported/);
  assert.equal(sql.match(/not imported/g).length, 3);
});
