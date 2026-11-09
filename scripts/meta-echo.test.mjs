// ทดสอบ echo จาก Meta (message_echoes): npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

// นาฬิกาคงที่ให้ตรงกับนาฬิกาของ fake DB (เริ่ม 2026-11-01) ไม่ขึ้นกับวันที่รันจริง
// กติกา Meta 24 ชม./7 วัน เทียบกับ Date.now() ถ้าใช้เวลาจริงเทสต์จะล้มหลังผ่านไป 7 วัน
mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-02T06:00:00Z") });

const { calls, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { parseMetaEchoes, parseMetaWebhook, classifyMetaEcho } = await import("../src/lib/channels/meta.ts");
const { sendReply, storeIncoming, storeMetaEcho, META_ECHO_STAFF_NAME, META_ECHO_AUTO_NAME } = await import("../src/lib/pipeline.ts");

const PAGE = "878132745372668";
const DOCDESK_APP = "1140939055044630";
const CUSTOMER = "psid-customer-1";
const realFetch = globalThis.fetch;

const echoBody = (message, { recipient = CUSTOMER, timestamp = Date.parse("2026-11-02T03:10:00Z") } = {}) => ({
  object: "page",
  entry: [{ id: PAGE, time: timestamp, messaging: [{ sender: { id: PAGE }, recipient: { id: recipient }, timestamp, message: { is_echo: true, ...message } }] }],
});
const echoOf = (message, opts) => parseMetaEchoes(echoBody(message, opts))[0];

let sent;
beforeEach(() => {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "fb", type: "facebook", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], reply_examples: [], response_events: [], tags: [], tag_rules: [], tag_events: [],
    staff: [{ id: "s1", role: "agent", active: true, display_name: "พนักงาน" }],
  });
  sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init?.body });
    return new Response(JSON.stringify({ recipient_id: CUSTOMER, message_id: `m_docdesk_${sent.length}` }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function customerAsks(text = "วัคซีนไข้หวัดใหญ่ราคาเท่าไหร่คะ") {
  const s = await storeIncoming({ channelType: "facebook", externalId: CUSTOMER, text, externalMessageId: `m_in_${Math.random()}` });
  await state.tables.conversations.find((c) => c.id === s.conversationId);
  return s.conversationId;
}
const conv = (id) => state.tables.conversations.find((c) => c.id === id);
const outMsgs = (id) => state.tables.messages.filter((m) => m.conversation_id === id && m.direction === "out");

// ---- parser ----
test("parser: echo ใช้ recipient เป็นลูกค้า และไม่ปนกับข้อความเข้า", () => {
  const body = echoBody({ mid: "m_echo_1", text: "สวัสดีค่ะ", app_id: 263902037430900 });
  assert.deepEqual(parseMetaWebhook(body), []);
  const [e] = parseMetaEchoes(body);
  assert.equal(e.customerId, CUSTOMER);
  assert.equal(e.messageId, "m_echo_1");
  assert.equal(e.appId, "263902037430900");
  assert.equal(e.sentAt, "2026-11-02T03:10:00.000Z");
});

test("parser: ข้อความลูกค้าไม่ใช่ echo", () => {
  const body = { object: "page", entry: [{ id: PAGE, messaging: [{ sender: { id: CUSTOMER }, recipient: { id: PAGE }, message: { mid: "m1", text: "hi" } }] }] };
  assert.deepEqual(parseMetaEchoes(body), []);
  assert.equal(parseMetaWebhook(body).length, 1);
});

test("parser: echo ที่เป็นรูปบันทึกเป็นข้อความแทน", () => {
  assert.equal(echoOf({ mid: "m2", attachments: [{ type: "image", payload: { url: "https://x" } }] }).text, "[ส่งรูปภาพจากเพจ]");
});

// ---- 1. คนตอบนอก DocDesk ----
test("1. echo จาก Meta Business Suite: ข้อความขาออกของลูกค้าผู้รับ ติดชื่อ Meta Business Suite", async () => {
  const id = await customerAsks();
  const r = await storeMetaEcho(echoOf({ mid: "m_mbs_1", text: "เข็มละ 390 บาทค่ะ" }));
  assert.equal(r.stored, "staff");
  const [m] = outMsgs(id);
  assert.equal(m.sender_type, "staff");
  assert.equal(m.sender_id, null);
  assert.equal(m.imported_sender_name, META_ECHO_STAFF_NAME);
  assert.equal(m.external_id, "m_mbs_1");
  const asked = state.tables.messages.find((x) => x.conversation_id === id && x.direction === "in");
  assert.ok(Date.parse(m.created_at) >= Date.parse(asked.created_at), "คำตอบต้องเรียงหลังคำถาม แม้เวลาของ Meta จะเก่ากว่า");
  assert.equal(state.tables.contacts.length, 1, "ไม่สร้างลูกค้าซ้ำจากผู้ส่ง (เพจ)");
});

// ---- 2. กันซ้ำ ----
test("2. echo ของข้อความที่ DocDesk ส่ง: เก็บ mid ตอนส่ง แล้วข้าม echo ที่ mid ตรง", async () => {
  const id = await customerAsks();
  await sendReply({ conversationId: id, textTh: "เข็มละ 390 บาทค่ะ", senderType: "staff", senderId: "s1", skipLearn: true });
  const mine = outMsgs(id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].external_id, "m_docdesk_1");
  // echo ของ DocDesk ไม่มี app_id ในเคสนี้ ใช้ mid กันซ้ำ
  const r = await storeMetaEcho(echoOf({ mid: "m_docdesk_1", text: "เข็มละ 390 บาทค่ะ" }));
  assert.equal(r.stored, null);
  assert.equal(outMsgs(id).length, 1);
});

test("2. echo มาก่อนบันทึก mid: ข้ามด้วย app_id ของแอป DocDesk", async () => {
  const id = await customerAsks();
  const r = await storeMetaEcho(echoOf({ mid: "m_not_saved_yet", text: "เข็มละ 390 บาทค่ะ", app_id: Number(DOCDESK_APP) }));
  assert.equal(r.stored, null);
  assert.equal(outMsgs(id).length, 0);
  assert.equal(conv(id).last_direction, "in");
});

test("2. echo เดียวกันส่งซ้ำ: บันทึกครั้งเดียว", async () => {
  const id = await customerAsks();
  const e = echoOf({ mid: "m_dup", text: "เข็มละ 390 บาทค่ะ" });
  await storeMetaEcho(e);
  assert.equal((await storeMetaEcho(e)).stored, null);
  assert.equal(outMsgs(id).length, 1);
});

test("2. ส่งรูป: เก็บ mid ของรูป", () => {
  const src = readFileSync("src/lib/pipeline.ts", "utf8");
  assert.match(src, /if \(mids\?\.\[0\]\) await db\.from\("messages"\)\.update\(\{ external_id: mids\[0\] \}\)\.eq\("id", messageId\)/);
});

// ---- 3. ผลต่อคิว คะแนน และการเรียนรู้ ----
test("3. คนตอบนอก DocDesk: ออกจากรอตอบ ล้าง needs_human ยกเลิก AI ที่รออยู่ ไม่คิดคะแนน และเรียนรู้", async () => {
  const id = await customerAsks();
  Object.assign(conv(id), { needs_human: true, ai_due_at: nextTime(), unread_count: 2 });
  assert.equal(conv(id).last_direction, "in");
  await storeMetaEcho(echoOf({ mid: "m_mbs_2", text: "เข็มละ 390 บาทค่ะ" }));
  const c = conv(id);
  assert.equal(c.last_direction, "out");
  assert.equal(c.waiting_since, null);
  assert.equal(c.needs_human, false);
  assert.equal(c.ai_due_at, null);
  assert.equal(c.unread_count, 0);
  assert.equal(state.tables.response_events.length, 0);
  assert.equal(state.tables.reply_examples.length, 1);
  assert.equal(state.tables.reply_examples[0].answer, "เข็มละ 390 บาทค่ะ");
  assert.match(state.tables.reply_examples[0].question, /วัคซีนไข้หวัดใหญ่/);
  assert.equal(state.tables.reply_examples[0].created_by, null);
});

test("3. แชทลับ: ออกจากรอตอบแต่ไม่นำไปเรียนรู้", async () => {
  const id = await customerAsks();
  conv(id).sensitive = true;
  await storeMetaEcho(echoOf({ mid: "m_mbs_3", text: "รบกวนมาที่คลินิกนะคะ" }));
  assert.equal(conv(id).last_direction, "out");
  assert.equal(state.tables.reply_examples.length, 0);
});

test("3. echo ถึงลูกค้าที่ยังไม่เคยทัก: สร้างรายชื่อด้วยชื่อที่ได้", async () => {
  await storeMetaEcho(echoOf({ mid: "m_new", text: "สวัสดีค่ะ" }, { recipient: "psid-new" }), "ลูกค้า Facebook");
  const c = state.tables.contacts.find((x) => x.external_id === "psid-new");
  assert.equal(c.display_name, "ลูกค้า Facebook");
});

test("3. echo ไม่ทับชื่อลูกค้าเดิม", async () => {
  await customerAsks();
  state.tables.contacts[0].display_name = "ชื่อจริง";
  await storeMetaEcho(echoOf({ mid: "m_name", text: "ค่ะ" }), "ลูกค้า Facebook");
  assert.equal(state.tables.contacts[0].display_name, "ชื่อจริง");
});

// ---- 4. ข้อความอัตโนมัติของเพจ ----
for (const [label, message, setup] of [
  ["มี metadata", { mid: "m_auto_1", text: "ขอบคุณที่ติดต่อเรา", metadata: "automated_response" }, () => {}],
  ["app_id อยู่ในรายการข้อความอัตโนมัติ", { mid: "m_auto_2", text: "ขอบคุณที่ติดต่อเรา", app_id: 777 }, () => state.tables.settings.push({ key: "meta_auto_reply_app_ids", value: ["777"] })],
]) {
  test(`4. ข้อความอัตโนมัติของเพจ (${label}): ข้อความระบบ แชทยังรอตอบ ไม่เรียนรู้`, async () => {
    setup();
    const id = await customerAsks();
    conv(id).needs_human = true;
    const before = conv(id).waiting_since;
    const r = await storeMetaEcho(echoOf(message));
    assert.equal(r.stored, "auto");
    const [m] = outMsgs(id);
    assert.equal(m.sender_type, "system");
    assert.equal(m.imported_sender_name, META_ECHO_AUTO_NAME);
    assert.equal(conv(id).last_direction, "in");
    assert.equal(conv(id).waiting_since, before);
    assert.equal(conv(id).needs_human, true);
    assert.equal(state.tables.reply_examples.length, 0);
    assert.equal(state.tables.response_events.length, 0);
  });
}

test("4. ข้อความอัตโนมัติไม่ขวางการตอบของ AI และคำถามที่ใช้เรียนรู้", async () => {
  const id = await customerAsks();
  await storeMetaEcho(echoOf({ mid: "m_auto_3", text: "ขอบคุณที่ติดต่อเรา", metadata: "auto" }));
  await storeMetaEcho(echoOf({ mid: "m_mbs_4", text: "เข็มละ 390 บาทค่ะ" }, { timestamp: Date.parse("2026-11-02T03:20:00Z") }));
  assert.match(state.tables.reply_examples[0].question, /วัคซีนไข้หวัดใหญ่/);
});

test("4. จด app_id ที่เห็น เพื่อใช้ตั้งรายการข้อความอัตโนมัติ", async () => {
  await customerAsks();
  await storeMetaEcho(echoOf({ mid: "m_seen", text: "ค่ะ", app_id: 263902037430900 }));
  const seen = state.tables.settings.find((s) => s.key === "meta_echo_app_ids").value;
  assert.equal(seen["263902037430900"].kind, "staff");
  assert.equal(seen["263902037430900"].count, 1);
});

test("classifyMetaEcho", () => {
  assert.equal(classifyMetaEcho({ appId: DOCDESK_APP, metadata: null }, []), "own");
  assert.equal(classifyMetaEcho({ appId: DOCDESK_APP, metadata: "x" }, []), "own");
  assert.equal(classifyMetaEcho({ appId: null, metadata: "x" }, []), "auto");
  assert.equal(classifyMetaEcho({ appId: "9", metadata: null }, ["9"]), "auto");
  assert.equal(classifyMetaEcho({ appId: "263902037430900", metadata: null }, []), "staff");
  assert.equal(classifyMetaEcho({ appId: null, metadata: null }, []), "staff");
});

test("migration: trigger คิวไม่นับข้อความระบบ และ mid ไม่ซ้ำ", () => {
  const sql = readFileSync("supabase/migrations/030_meta_echoes.sql", "utf8");
  assert.equal((sql.match(/sender_type <> 'system'/g) ?? []).length, 2);
  assert.match(sql, /create unique index if not exists messages_external_id_key on messages \(external_id\) where external_id is not null/);
});

test("หน้าแชทแสดงชื่อผู้ส่งนอก DocDesk", () => {
  const src = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(src, /if \(m\.imported_sender_name\) return/);
});

test("webhook: echo ที่ล้มไม่ทำให้รายการอื่นหาย", () => {
  const src = readFileSync("src/app/api/webhooks/meta/route.ts", "utf8");
  assert.match(src, /for \(const echo of parseMetaEchoes\(body\)\) \{\s*try \{/);
  assert.ok(calls.chat === 0);
});

// ---- เจ้าหน้าที่ทักแชทที่เสร็จแล้ว ----
const { tabsOf } = await import("../src/lib/case-flow.ts");
const { isStaffQuestion } = await import("../src/lib/suggest-rules.ts");
const closeChat = (id) => Object.assign(conv(id), { status: "closed", closed_at: nextTime(), last_direction: "out", waiting_since: null });

test("isStaffQuestion: คำถามนับ, นะคะ/ค่ะ ไม่นับ", () => {
  for (const q of ["สะดวกมาวันไหนคะ", "สนใจจองไหมคะ", "ได้รับผลตรวจหรือยังคะ", "ตรวจกี่รายการคะ", "พรุ่งนี้ 10 โมงสะดวกคะ", "OK?"]) assert.equal(isStaffQuestion(q), true, q);
  for (const t of ["ยินดีค่ะ", "ขอบคุณนะคะ", "ได้เลยค่ะ", "รับทราบนะคะ 😊", "เปิด 8 โมงค่ะ"]) assert.equal(isStaffQuestion(t), false, t);
});

test("ส่งจาก DocDesk ในแชทที่เสร็จแล้ว: ถามกลับมาอยู่ในทั้งหมด ไม่เข้ารอตอบ / ตอบรับเฉยๆ ยังเสร็จแล้ว", async () => {
  const id = await customerAsks();
  await sendReply({ conversationId: id, textTh: "เข็มละ 390 บาทค่ะ", senderType: "staff", senderId: "s1", skipLearn: true });
  closeChat(id);
  await sendReply({ conversationId: id, textTh: "ยินดีค่ะ", senderType: "staff", senderId: "s1", skipLearn: true });
  assert.equal(conv(id).status, "closed");
  await sendReply({ conversationId: id, textTh: "สะดวกมาฉีดวันไหนคะ", senderType: "staff", senderId: "s1", skipLearn: true });
  assert.equal(conv(id).status, "open");
  conv(id).last_direction = "out";
  assert.deepEqual(tabsOf(conv(id)), ["open"]);
});

test("ตอบจาก Meta Business Suite ในแชทที่เสร็จแล้ว: ถามกลับมา / ตอบรับและข้อความอัตโนมัติของเพจ ยังเสร็จแล้ว", async () => {
  const id = await customerAsks();
  closeChat(id);
  await storeMetaEcho(echoOf({ mid: "m_auto_1", text: "สนใจบริการไหนคะ", metadata: "automated_response" }));
  assert.equal(conv(id).status, "closed", "ข้อความอัตโนมัติไม่ใช่คนทัก");
  await storeMetaEcho(echoOf({ mid: "m_mbs_8", text: "ขอบคุณนะคะ" }));
  assert.equal(conv(id).status, "closed");
  await storeMetaEcho(echoOf({ mid: "m_mbs_9", text: "สะดวกมาวันไหนคะ" }));
  assert.equal(conv(id).status, "open");
});
