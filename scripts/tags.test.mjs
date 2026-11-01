// ทดสอบระบบแท็ก: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { aiTiming, processIncoming, setConversationTag, storeIncoming } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const {
  bangkokRange, buildBuckets, buildReportTable, buildTagCsv, isValidDate, matchTagRules, niceMax, sanitizeSuggestedTags,
} = await import("../src/lib/tags.ts");

const tag = (name, group) => ({ id: name, name, group, color: "#000000", sort: 10, active: true });
const SEED = [tag("วัคซีน", "topic"), tag("B2B บริษัท", "topic"), tag("รอนัด", "status"), tag("ต่างชาติ", "customer")];
const RULES = [
  { kind: "keyword", keyword: "บริษัท|พนักงาน|โรงงาน", tag: "B2B บริษัท" },
  { kind: "non_thai", keyword: "", tag: "ต่างชาติ" },
];
const SESSION = "11111111-1111-4111-8111-111111111111";

function setup(mode = "assist") {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: mode }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [],
    conversations: [],
    tags: SEED.map((t) => ({ ...t })),
    tag_rules: RULES.map((r) => ({ ...r })),
    tag_events: [],
  });
  aiTiming.debounceMs = 5;
}
const conv = () => state.tables.conversations[0];
const incoming = (text) => storeIncoming({ channelType: "web", externalId: SESSION, text });
const events = () => state.tables.tag_events.map((e) => `${e.action}:${e.tag}:${e.by}`);

beforeEach(() => {
  setup();
  replies.next = { needs_human: false, suggested_tags: [], options: [{ text: "ร่าง", source: "knowledge", ref_ids: [], confidence: 0.8 }] };
});

// ---- กฎคำสำคัญ ----
const names = SEED.map((t) => t.name);

test("กฎ: คำใดคำหนึ่งตรงก็ติดแท็ก ไม่สนตัวพิมพ์ใหญ่เล็ก", () => {
  assert.deepEqual(matchTagRules("โรงงานเรามี 50 คน", "th", RULES, names), ["B2B บริษัท"]);
  assert.deepEqual(matchTagRules("our COMPANY", "th", [{ kind: "keyword", keyword: "company", tag: "วัคซีน" }], names), ["วัคซีน"]);
  assert.deepEqual(matchTagRules("ฉีดวัคซีน", "th", RULES, names), []);
});

test("กฎ: ภาษาที่ไม่ใช่ไทยติดต่างชาติ", () => {
  assert.deepEqual(matchTagRules("hello", "en", RULES, names), ["ต่างชาติ"]);
  assert.deepEqual(matchTagRules("สวัสดี", "th", RULES, names), []);
});

test("กฎ: แท็กที่ปิดใช้ไม่ถูกติด", () => {
  assert.deepEqual(matchTagRules("บริษัท", "th", RULES, ["วัคซีน"]), []);
});

test("กฎ: keyword เป็นข้อความธรรมดา ไม่ใช่ regex และช่องว่างไม่ตรงทุกข้อความ", () => {
  assert.deepEqual(matchTagRules("อะไรก็ได้", "th", [{ kind: "keyword", keyword: ".*", tag: "วัคซีน" }], names), []);
  assert.deepEqual(matchTagRules("อะไรก็ได้", "th", [{ kind: "keyword", keyword: "(", tag: "วัคซีน" }], names), []);
  assert.deepEqual(matchTagRules("อะไรก็ได้", "th", [{ kind: "keyword", keyword: "| |", tag: "วัคซีน" }], names), []);
});

test("ข้อความเข้า: กฎทำงานโดยไม่เรียก AI และบันทึก event", async () => {
  await incoming("บริษัทเราสนใจตรวจสุขภาพ");
  assert.deepEqual(conv().tags, ["B2B บริษัท"]);
  assert.deepEqual(events(), ["add:B2B บริษัท:rule"]);
  assert.deepEqual(calls, { chat: 0, embed: 0 });
});

test("ข้อความเข้าซ้ำ: ไม่บันทึก event ซ้ำ", async () => {
  await incoming("บริษัทเรา");
  await incoming("โรงงานเรา");
  assert.equal(state.tables.tag_events.length, 1);
});

test("ข้อความภาษาอื่น: ติดต่างชาติจากภาษาที่ตรวจตอนแปล", async () => {
  replies.next = { language: "en", th: "สวัสดี ราคาเท่าไหร่" };
  await incoming("Hello, how much is the vaccine?");
  assert.deepEqual(conv().tags, ["ต่างชาติ"]);
  assert.equal(calls.chat, 1, "ใช้การเรียกของการแปลเดิม ไม่เรียกเพิ่ม");
});

test("ok หรือ thanks: ไม่ติดต่างชาติ", async () => {
  replies.next = { language: "en", th: "ขอบคุณ" };
  await incoming("thanks");
  assert.deepEqual(conv().tags ?? [], []);
  await incoming("OK");
  assert.deepEqual(conv().tags ?? [], []);
});

test("เจ้าหน้าที่เอาแท็กออกแล้ว: กฎและ AI ไม่ติดกลับ แต่เจ้าหน้าที่ติดเองได้", async () => {
  const s = await incoming("บริษัทเรา");
  await setConversationTag(s.conversationId, "B2B บริษัท", "remove", "staff");
  await incoming("บริษัทเราอีกครั้ง");
  assert.deepEqual(conv().tags, []);
  await setConversationTag(s.conversationId, "B2B บริษัท", "add", "ai");
  assert.deepEqual(conv().tags, []);
  await setConversationTag(s.conversationId, "B2B บริษัท", "add", "staff");
  assert.deepEqual(conv().tags, ["B2B บริษัท"]);
  assert.deepEqual(events(), ["add:B2B บริษัท:rule", "remove:B2B บริษัท:staff", "add:B2B บริษัท:staff"]);
});

test("กฎล้มเหลว: ข้อความลูกค้าต้องไม่หาย", async (t) => {
  t.mock.method(console, "error", () => {});
  delete state.tables.tag_rules;
  state.tables.tags = null;
  const s = await incoming("บริษัทเรา");
  assert.ok(s.messageId);
});

test("รูปอย่างเดียว: ไม่รันกฎ", async () => {
  await storeIncoming({ channelType: "web", externalId: SESSION, text: "", isImage: true });
  assert.deepEqual(conv().tags ?? [], []);
});

// ---- AI เสนอแท็ก ----
test("กรองแท็กจาก AI: เหลือเฉพาะที่มีจริง ไม่ซ้ำ ไม่เกิน 3", () => {
  assert.deepEqual(sanitizeSuggestedTags(["วัคซีน", "แท็กที่แต่งเอง", "วัคซีน", 5, null], names), ["วัคซีน"]);
  assert.deepEqual(sanitizeSuggestedTags("วัคซีน", names), []);
  assert.deepEqual(sanitizeSuggestedTags(undefined, names), []);
  assert.equal(sanitizeSuggestedTags(names, names).length, 3);
});

test("AI เสนอแท็กในการเรียกเดิม: ไม่เรียก LLM เพิ่ม และส่งรายชื่อแท็กไปด้วย", async () => {
  replies.next.suggested_tags = ["วัคซีน", "แท็กที่แต่งเอง"];
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  const r = await generateSuggestions(s.conversationId);
  assert.equal(calls.chat, 1);
  assert.deepEqual(r.suggested_tags, ["วัคซีน"]);
  assert.deepEqual(state.tables.suggestions[0].suggested_tags, ["วัคซีน"]);
  assert.match(calls.lastPrompt, /suggested_tags/);
  assert.match(calls.lastPrompt, /รายการแท็กที่เลือกได้\n.*วัคซีน/);
});

test("โหมดผู้ช่วย: เสนออย่างเดียว ไม่ติดเอง", async () => {
  replies.next.suggested_tags = ["วัคซีน"];
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await generateSuggestions(s.conversationId);
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(conv().tags ?? [], []);
});

test("โหมดอัตโนมัติ: ติดเองเฉพาะกลุ่ม topic", async () => {
  setup("auto");
  replies.next = { needs_human: false, suggested_tags: ["วัคซีน", "รอนัด", "ต่างชาติ"], options: [{ text: "ร่าง", source: "knowledge", ref_ids: [], confidence: 0.8 }] };
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(conv().tags, ["วัคซีน"]);
  assert.deepEqual(events(), ["add:วัคซีน:ai"]);
  assert.equal(calls.chat, 1);
});

test("โหมดอัตโนมัติ: แท็ก topic ที่ปิดใช้ไม่ถูกติด", async () => {
  setup("auto");
  state.tables.tags.find((t) => t.name === "วัคซีน").active = false;
  replies.next = { needs_human: false, suggested_tags: ["วัคซีน"], options: [{ text: "ร่าง", source: "knowledge", ref_ids: [], confidence: 0.8 }] };
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(conv().tags ?? [], []);
});

test("โหมดคนตอบก่อน: ไม่ติดเอง", async () => {
  setup("fallback");
  state.tables.settings.push({ key: "business_hours", value: { tz: "Asia/Bangkok", days: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, ["00:00", "23:59"]])) } });
  replies.next = { needs_human: false, suggested_tags: ["วัคซีน"], options: [{ text: "ร่าง", source: "knowledge", ref_ids: [], confidence: 0.8 }] };
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await processIncoming(s.conversationId, s.messageId);
  assert.deepEqual(conv().tags ?? [], []);
});

test("คำแนะนำเดิมถูกใช้ซ้ำ: คงแท็กที่เสนอ และไม่เรียก LLM", async () => {
  replies.next.suggested_tags = ["วัคซีน"];
  const s = await incoming("ฉีดวัคซีนราคาเท่าไหร่");
  await generateSuggestions(s.conversationId);
  const again = await generateSuggestions(s.conversationId);
  assert.equal(calls.chat, 1);
  assert.deepEqual(again.suggested_tags, ["วัคซีน"]);
});

// ---- รายงาน ----
test("ช่วงเวลารายวันรวมวันที่ไม่มีข้อมูล และข้ามเดือนได้", () => {
  assert.deepEqual(buildBuckets("day", "2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
});

test("ช่วงเวลารายเดือนข้ามปีได้", () => {
  assert.deepEqual(buildBuckets("month", "2026-11-15", "2027-02-01"), ["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
});

test("ช่วงวันตามเวลาไทย: วันสิ้นสุดรวมทั้งวัน", () => {
  const r = bangkokRange("2026-11-01", "2026-11-01");
  assert.equal(new Date(r.from).toISOString(), "2026-10-31T17:00:00.000Z");
  assert.equal(r.to, "2026-11-01T17:00:00.000Z");
});

test("ตรวจรูปแบบวันที่", () => {
  assert.equal(isValidDate("2026-11-01"), true);
  for (const bad of [null, "", "2026-13-01", "1/11/2026", "2026-11-01'; drop table tags"]) assert.equal(isValidDate(bad), false, String(bad));
});

test("ตารางรายงาน: เติม 0 เรียงมากไปน้อย และไม่นับข้อมูลนอกช่วง", () => {
  const t = buildReportTable([
    { bucket: "2026-11-01", tag: "ก", chats: 1 },
    { bucket: "2026-11-02", tag: "ข", chats: "3" },
    { bucket: "2026-11-02", tag: "ก", chats: 1 },
    { bucket: "2026-12-01", tag: "ค", chats: 9 },
  ], ["2026-11-01", "2026-11-02"]);
  assert.deepEqual(t.rows, [
    { tag: "ข", counts: [0, 3], total: 3 },
    { tag: "ก", counts: [1, 1], total: 2 },
  ]);
});

test("แกน Y เป็นเลขกลม", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(3), 3);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(13), 20);
  assert.equal(niceMax(420), 500);
});

// ---- CSV ----
const row = (extra) => ({ display_name: "สมชาย", channel: "line", tag: "วัคซีน", tagged_at: "2026-10-31T18:00:00Z", ...extra });

test("CSV: มีเฉพาะชื่อ ช่องทาง แท็ก วันที่ เป็นวันตามเวลาไทย และมี BOM", () => {
  const csv = buildTagCsv([row()]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.deepEqual(csv.slice(1).trim().split("\r\n"), ["ชื่อที่แสดง,ช่องทาง,แท็ก,วันที่ติดแท็ก", "สมชาย,LINE,วัคซีน,2026-11-01"]);
});

test("CSV: ไม่มีเนื้อหาแชทแม้แถวข้อมูลติดมา", () => {
  const csv = buildTagCsv([row({ body: "ปวดท้องมาก", last_message_preview: "เรื่องส่วนตัว" })]);
  assert.ok(!csv.includes("ปวดท้อง"));
  assert.ok(!csv.includes("เรื่องส่วนตัว"));
});

test("CSV: กันสูตร Excel จากชื่อลูกค้า และจัดการเครื่องหมายคำพูด", () => {
  const lines = buildTagCsv([
    row({ display_name: "=HYPERLINK(\"http://evil\")" }),
    row({ display_name: "+66812345678" }),
    row({ display_name: "@user" }),
    row({ display_name: "-1+1" }),
    row({ display_name: "สมชาย, ใจดี" }),
    row({ display_name: "บรรทัด\nใหม่" }),
    row({ display_name: null }),
  ]).slice(1).split("\r\n");
  assert.ok(lines[1].startsWith(`"'=HYPERLINK(""http://evil"")"`));
  assert.ok(lines[2].startsWith("'+66812345678,"));
  assert.ok(lines[3].startsWith("'@user,"));
  assert.ok(lines[4].startsWith("'-1+1,"));
  assert.ok(lines[5].startsWith(`"สมชาย, ใจดี",`));
  assert.ok(lines[6].startsWith(`"บรรทัด\nใหม่",`));
  assert.ok(lines[7].startsWith("ลูกค้า,"));
});
