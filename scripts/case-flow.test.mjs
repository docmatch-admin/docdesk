// ทดสอบขั้นตอนปิดเคส: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { storeIncoming } = await import("../src/lib/pipeline.ts");
const { CLEARED_ON_REOPEN_TAG, isWaitingForReply, nextOpenChat, titleWithCount, waitBadge } = await import("../src/lib/case-flow.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const chats = (...spec) => spec.map(([id, status]) => ({ id, status }));

test("แชทถัดไป: ตัวที่อยู่ถัดจากแชทที่เพิ่งปิด", () => {
  assert.equal(nextOpenChat(chats(["a", "open"], ["b", "open"], ["c", "open"]), "b"), "c");
});

test("แชทถัดไป: ข้ามแชทที่ปิดแล้ว", () => {
  assert.equal(nextOpenChat(chats(["a", "open"], ["b", "closed"], ["c", "open"]), "a"), "c");
});

test("แชทถัดไป: ถึงท้ายรายการแล้ววนกลับต้นรายการ", () => {
  assert.equal(nextOpenChat(chats(["a", "open"], ["b", "open"], ["c", "open"]), "c"), "a");
});

test("แชทถัดไป: ไม่เหลือแชทเปิดอยู่ คืน null", () => {
  assert.equal(nextOpenChat(chats(["a", "open"], ["b", "closed"]), "a"), null);
  assert.equal(nextOpenChat([], "a"), null);
});

test("แชทถัดไป: แชทปัจจุบันยังเป็น open ในรายการเก่า ต้องไม่เลือกตัวเอง", () => {
  assert.equal(nextOpenChat(chats(["a", "open"]), "a"), null);
});

test("แชทถัดไป: แชทปัจจุบันไม่อยู่ในรายการ เลือกตัวแรกที่เปิด", () => {
  assert.equal(nextOpenChat(chats(["a", "closed"], ["b", "open"]), "z"), "b");
});

// ---- รอตอบ ----
test("รอตอบ: เปิดอยู่และข้อความล่าสุดเป็นของลูกค้าเท่านั้น", () => {
  assert.equal(isWaitingForReply({ status: "open", last_direction: "in" }), true);
  assert.equal(isWaitingForReply({ status: "open", last_direction: "out" }), false);
  assert.equal(isWaitingForReply({ status: "closed", last_direction: "in" }), false);
  assert.equal(isWaitingForReply({ status: "open", last_direction: null }), false);
});

const NOW = Date.parse("2026-11-01T10:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();

for (const [minutes, text, level] of [
  [0, "รอไม่ถึงนาที", "normal"],
  [1, "รอ 1 นาที", "normal"],
  [10, "รอ 10 นาที", "normal"],
  [11, "รอ 11 นาที", "warn"],
  [12, "รอ 12 นาที", "warn"],
  [30, "รอ 30 นาที", "warn"],
  [31, "รอ 31 นาที", "late"],
  [125, "รอ 2 ชม. 5 นาที", "late"],
  [3 * 24 * 60, "รอ 3 วัน", "late"],
]) {
  test(`เวลารอ ${minutes} นาที: ${text} (${level})`, () => {
    assert.deepEqual(waitBadge(minutesAgo(minutes), NOW), { text, level });
  });
}

test("เวลารอ: ไม่มีเวลาไม่แสดง และนาฬิกาเพี้ยนไม่ติดลบ", () => {
  assert.equal(waitBadge(null, NOW), null);
  assert.equal(waitBadge(minutesAgo(-5), NOW).text, "รอไม่ถึงนาที");
});

test("ป้ายบนแท็บเบราว์เซอร์", () => {
  assert.equal(titleWithCount("DocDesk", 3), "(3) DocDesk");
  assert.equal(titleWithCount("(3) DocDesk", 5), "(5) DocDesk");
  assert.equal(titleWithCount("(3) DocDesk", 0), "DocDesk");
  assert.equal(titleWithCount("DocDesk", 0), "DocDesk");
  assert.equal(titleWithCount("DocDesk", 150), "(99+) DocDesk");
  assert.equal(titleWithCount("(99+) DocDesk", 2), "(2) DocDesk");
});

// ---- ลูกค้าทักกลับมา ----
function setup({ status, tags }) {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [{ id: "ct", channel_id: "ch", external_id: SESSION, language: "th" }],
    conversations: [{ id: "c1", contact_id: "ct", channel_id: "ch", status, tags: [...tags], unread_count: 0, needs_human: false }],
    tags: [],
    tag_rules: [],
    tag_events: [],
  });
}
const conv = () => state.tables.conversations[0];
const incoming = (text, extra = {}) => storeIncoming({ channelType: "web", externalId: SESSION, text, ...extra });
const events = () => state.tables.tag_events.map((e) => `${e.action}:${e.tag}:${e.by}`);

beforeEach(() => setup({ status: "open", tags: [] }));

test("แท็กที่เอาออกคือนัดแล้ว", () => assert.equal(CLEARED_ON_REOPEN_TAG, "นัดแล้ว"));

test("ทักกลับหลังปิดเคส: แชทเปิดเอง เอานัดแล้วออก เก็บแท็กอื่น และไม่เรียก AI", async () => {
  setup({ status: "closed", tags: ["นัดแล้ว", "วัคซีน", "ลูกค้าประจำ"] });
  await incoming("สอบถามเพิ่มค่ะ");
  assert.equal(conv().status, "open");
  assert.deepEqual(conv().tags, ["วัคซีน", "ลูกค้าประจำ"]);
  assert.deepEqual(events(), ["remove:นัดแล้ว:rule"]);
  assert.deepEqual(calls, { chat: 0, embed: 0 });
});

test("แชทยังเปิดอยู่: ไม่แตะนัดแล้วที่เจ้าหน้าที่เพิ่งติด", async () => {
  setup({ status: "open", tags: ["นัดแล้ว"] });
  await incoming("ขอบคุณค่ะ");
  assert.deepEqual(conv().tags, ["นัดแล้ว"]);
  assert.deepEqual(events(), []);
});

test("ทักกลับโดยไม่มีแท็กนัดแล้ว: เปิดแชทเฉยๆ ไม่มี event", async () => {
  setup({ status: "closed", tags: ["ตามต่อ"] });
  await incoming("สวัสดีค่ะ");
  assert.equal(conv().status, "open");
  assert.deepEqual(conv().tags, ["ตามต่อ"]);
  assert.deepEqual(events(), []);
});

test("ทักกลับด้วยรูปอย่างเดียว: เอานัดแล้วออกเหมือนกัน", async () => {
  setup({ status: "closed", tags: ["นัดแล้ว"] });
  await incoming("", { isImage: true });
  assert.equal(conv().status, "open");
  assert.deepEqual(conv().tags, []);
});

test("ระบบเอาออกแล้ว เจ้าหน้าที่ กฎ และ AI ยังติดกลับได้ เพราะไม่ใช่การแก้แท็กผิดของเจ้าหน้าที่", async () => {
  setup({ status: "closed", tags: ["นัดแล้ว"] });
  await incoming("สวัสดีค่ะ");
  const { setConversationTag } = await import("../src/lib/pipeline.ts");
  await setConversationTag("c1", "นัดแล้ว", "add", "rule");
  assert.deepEqual(conv().tags, ["นัดแล้ว"]);
});

test("เอาแท็กออกไม่สำเร็จ: ข้อความลูกค้าต้องไม่หาย", async (t) => {
  t.mock.method(console, "error", () => {});
  setup({ status: "closed", tags: ["นัดแล้ว"] });
  const realConversations = state.tables.conversations;
  const originalFind = realConversations.find;
  // ทำให้ RPC ล้มเหลวโดยไม่กระทบการอัปเดตแชท
  realConversations.find = () => undefined;
  const s = await incoming("สวัสดีค่ะ");
  realConversations.find = originalFind;
  assert.ok(s.messageId);
  assert.equal(state.tables.messages.length, 1);
});
