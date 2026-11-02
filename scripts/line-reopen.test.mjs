// ทดสอบแชท LINE ที่ลูกค้าทักกลับมา: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { storeIncoming } = await import("../src/lib/pipeline.ts");
const { isThanksOrSticker } = await import("../src/lib/suggest-rules.ts");
const { findArchiveCandidates, sameDisplayName } = await import("../src/lib/archive-store.ts");
const { tabsOf } = await import("../src/lib/case-flow.ts");

const USER = "U1234567890abcdef";
beforeEach(() => {
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "line", type: "line", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: [], tag_rules: [], tag_events: [], reply_examples: [], bookings: [],
    archive_merge_dismissed: [],
  });
});

const say = (text, extra = {}) => storeIncoming({ channelType: "line", externalId: USER, text, displayName: "คุณสมใจ", externalMessageId: `m${Math.random()}`, ...extra });
const conv = (id) => state.tables.conversations.find((c) => c.id === id);
async function closedChat() {
  const { conversationId } = await say("สอบถามวัคซีนค่ะ");
  state.tables.messages.push({ id: `out${Math.random()}`, conversation_id: conversationId, direction: "out", sender_type: "staff", body: "ได้ค่ะ", created_at: nextTime() });
  Object.assign(conv(conversationId), { status: "closed", closed_at: nextTime(), last_direction: "out", waiting_since: null });
  return conversationId;
}

// ---- แชทที่เสร็จแล้ว ----
test("แชทที่เสร็จแล้ว: ข้อความใหม่เปิดกลับมาและอยู่ในรอตอบ", async () => {
  const id = await closedChat();
  await say("พรุ่งนี้เปิดกี่โมงคะ");
  const c = conv(id);
  assert.equal(c.status, "open");
  assert.equal(c.last_direction, "in");
  assert.deepEqual(tabsOf(c), ["open", "waiting"]);
});

for (const text of ["ขอบคุณค่ะ", "ขอบคุณมากนะคะ 🙏", "[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]", "ขอบคุณค่ะ\n[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]"]) {
  test(`แชทที่เสร็จแล้ว: "${text.replace("\n", " + ")}" ไม่เปิดกลับมา`, async () => {
    const id = await closedChat();
    await say(text);
    assert.equal(conv(id).status, "closed");
  });
}

for (const [label, text, extra] of [
  ["คำขอบคุณพร้อมคำถาม", "ขอบคุณค่ะ แล้ววันเสาร์เปิดไหมคะ", {}],
  ["ตอบรับ", "โอเคค่ะ", {}],
  ["รูป", "", { isImage: true }],
  ["วิดีโอ", "[ลูกค้าส่ง video — เปิดดูใน LINE OA]", {}],
]) {
  test(`แชทที่เสร็จแล้ว: ${label} เปิดกลับมา`, async () => {
    const id = await closedChat();
    await say(text, extra);
    assert.equal(conv(id).status, "open");
  });
}

test("isThanksOrSticker", () => {
  assert.equal(isThanksOrSticker("ขอบคุณค่ะ"), true);
  assert.equal(isThanksOrSticker("[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]"), true);
  assert.equal(isThanksOrSticker("ขอบคุณค่ะ", true), false);
  assert.equal(isThanksOrSticker("ราคาเท่าไหร่"), false);
  assert.equal(isThanksOrSticker(""), false);
});

// ---- แชทเก่า ----
test("แชทเก่าที่ได้ข้อความจริงจาก webhook: เลิกเป็นแชทเก่า เปิด และอยู่ในรอตอบ", async () => {
  state.tables.contacts.push({ id: "c-old", channel_id: "line", external_id: USER, display_name: "คุณสมใจ" });
  state.tables.conversations.push({ id: "conv-old", channel_id: "line", contact_id: "c-old", status: "closed", archived: true, closed_at: nextTime(), unread_count: 0, tags: [] });
  await say("สวัสดีค่ะ จะจองวัคซีน");
  const c = conv("conv-old");
  assert.equal(c.archived, false);
  assert.equal(c.status, "open");
  assert.deepEqual(tabsOf(c), ["open", "waiting"]);
});

test("แชทเก่า: แม้เป็นคำขอบคุณก็เลิกเป็นแชทเก่า เพราะต้องพิมพ์ตอบได้", async () => {
  state.tables.contacts.push({ id: "c-old", channel_id: "line", external_id: USER, display_name: "คุณสมใจ" });
  state.tables.conversations.push({ id: "conv-old", channel_id: "line", contact_id: "c-old", status: "closed", archived: true, closed_at: nextTime(), unread_count: 0, tags: [] });
  await say("ขอบคุณค่ะ");
  assert.equal(conv("conv-old").archived, false);
  assert.equal(conv("conv-old").status, "open");
});

// ---- ลูกค้าใหม่ที่ชื่อตรงกับแชทเก่า ----
test("ลูกค้าใหม่ชื่อตรงกับแชทเก่า: ได้แชทใหม่ที่เปิดอยู่ทันที และมีแชทเก่าให้ถามรวม", async () => {
  state.tables.contacts.push({ id: "c-arch", channel_id: "line", external_id: "archived:x", display_name: "คุณสมใจ " });
  state.tables.conversations.push({ id: "conv-arch", channel_id: "line", contact_id: "c-arch", status: "closed", archived: true, sensitive: false, unread_count: 0, tags: [] });
  state.tables.messages.push({ id: "old1", conversation_id: "conv-arch", direction: "in", sender_type: "customer", body: "เก่า", imported: true, created_at: nextTime() });
  const { conversationId } = await say("สวัสดีค่ะ");
  assert.notEqual(conversationId, "conv-arch");
  const c = conv(conversationId);
  assert.equal(c.status, "open");
  assert.notEqual(c.archived, true);
  assert.deepEqual(tabsOf(c), ["open", "waiting"]);
  const candidates = await findArchiveCandidates(conversationId, true);
  assert.deepEqual(candidates.map((x) => x.id), ["conv-arch"]);
  assert.equal(conv("conv-arch").archived, true, "แชทเก่ายังรอเจ้าหน้าที่ตัดสินใจ ไม่รวมเอง");
});

test("ชื่อเทียบแบบไม่สนช่องว่างและตัวพิมพ์", () => {
  assert.equal(sameDisplayName("Som  Jai ", "som jai"), true);
  assert.equal(sameDisplayName("", ""), false);
  assert.equal(sameDisplayName("ก", "ข"), false);
});

test("แถบถามรวมประวัติไม่ถูกซ่อนในแชทปกติ", () => {
  const src = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(src, /\{!selected\.archived && !locked && \(\s*<ArchiveMergeBar/);
});

// ---- ตัวกรองของฉัน ----
test("ของฉัน: รวมแชทที่ยังไม่มีผู้ดูแล", () => {
  const src = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(src, /query = query\.or\(`assigned_to\.eq\.\$\{me\.id\},assigned_to\.is\.null`\)/);
  assert.doesNotMatch(src, /query\.eq\("assigned_to", me\.id\)/);
});

test("ตัวกรองเริ่มที่ทุกคน และไม่จำค่าของฉันไว้", () => {
  const src = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(src, /useState<"all" \| "mine">\("all"\)/);
  assert.doesNotMatch(src, /localStorage\.getItem\(SCOPE_KEY\)/);
});
