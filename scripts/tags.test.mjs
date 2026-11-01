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
const B2B_RULE = {
  kind: "keyword",
  keyword: "ตรวจสุขภาพพนักงาน|พนักงาน|โรงงาน|หมู่คณะ|ใบเสนอราคา|ออกหน่วย|ฝ่ายบุคคล|HR",
  exclude_keywords: "ประกัน|บัตรทอง|ประกันสังคม",
  tag: "B2B บริษัท",
};
const RULES = [B2B_RULE, { kind: "non_thai", keyword: "", exclude_keywords: "", tag: "ต่างชาติ" }];
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

test('"ใช้บริษัทประกันได้ไหม" ไม่ติด B2B', () => {
  assert.deepEqual(matchTagRules("ใช้บริษัทประกันได้ไหม", 0, RULES, names), []);
});

test('"ขอใบเสนอราคาตรวจสุขภาพพนักงาน 50 คน" ติด B2B', () => {
  assert.deepEqual(matchTagRules("ขอใบเสนอราคาตรวจสุขภาพพนักงาน 50 คน", 0, RULES, names), ["B2B บริษัท"]);
});

test("คำว่าบริษัทเดี่ยวๆ ไม่ติด B2B แล้ว", () => {
  assert.deepEqual(matchTagRules("บริษัทอยู่ใกล้คลินิกไหม", 0, RULES, names), []);
});

for (const text of ["โรงงานเรามี 50 คน", "ตรวจสุขภาพหมู่คณะ", "ขอออกหน่วยตรวจ", "ผมอยู่ฝ่ายบุคคล", "ติดต่อฝ่าย HR", "ฝ่ายHRครับ", "hr department"]) {
  test(`B2B ติด: ${text}`, () => assert.deepEqual(matchTagRules(text, 0, RULES, names), ["B2B บริษัท"]));
}

for (const text of ["พนักงานใช้ประกันได้ไหม", "พนักงานใช้บัตรทองได้ไหม", "โรงงานใช้ประกันสังคมได้ไหม", "ขอใบเสนอราคา ประกันกลุ่ม"]) {
  test(`คำยกเว้นชนะคำสำคัญ: ${text}`, () => assert.deepEqual(matchTagRules(text, 0, RULES, names), []));
}

test("คำอังกฤษต้องตรงทั้งคำ: HR ไม่ตรงกับ three หรือ HRD", () => {
  assert.deepEqual(matchTagRules("three doses please", 0, RULES, names), []);
  assert.deepEqual(matchTagRules("HRD course", 0, RULES, names), []);
});

test("คำยกเว้นภาษาอังกฤษก็ตรงทั้งคำ", () => {
  const rule = { kind: "keyword", keyword: "staff", exclude_keywords: "hr", tag: "วัคซีน" };
  assert.deepEqual(matchTagRules("staff three", 0, [rule], names), ["วัคซีน"]);
  assert.deepEqual(matchTagRules("staff hr", 0, [rule], names), []);
});

test("กฎไม่มีคำยกเว้นยังทำงาน", () => {
  assert.deepEqual(matchTagRules("our COMPANY", 0, [{ kind: "keyword", keyword: "company", tag: "วัคซีน" }], names), ["วัคซีน"]);
  assert.deepEqual(matchTagRules("our company", 0, [{ kind: "keyword", keyword: "company", exclude_keywords: "", tag: "วัคซีน" }], names), ["วัคซีน"]);
});

test("กฎไม่ใช่ภาษาไทย: ติดเมื่อครบ 2 ข้อความ", () => {
  assert.deepEqual(matchTagRules("hello", 0, RULES, names), []);
  assert.deepEqual(matchTagRules("hello", 1, RULES, names), []);
  assert.deepEqual(matchTagRules("hello", 2, RULES, names), ["ต่างชาติ"]);
});

test("กฎ: แท็กที่ปิดใช้ไม่ถูกติด", () => {
  assert.deepEqual(matchTagRules("โรงงาน", 2, RULES, ["วัคซีน"]), []);
});

test("กฎ: keyword เป็นข้อความธรรมดา ไม่ใช่ regex และช่องว่างไม่ตรงทุกข้อความ", () => {
  assert.deepEqual(matchTagRules("อะไรก็ได้", 0, [{ kind: "keyword", keyword: ".*", tag: "วัคซีน" }], names), []);
  assert.deepEqual(matchTagRules("อะไรก็ได้", 0, [{ kind: "keyword", keyword: "(", tag: "วัคซีน" }], names), []);
  assert.deepEqual(matchTagRules("อะไรก็ได้", 0, [{ kind: "keyword", keyword: "| |", tag: "วัคซีน" }], names), []);
});

test("ข้อความเข้า: กฎทำงานโดยไม่เรียก AI และบันทึก event", async () => {
  await incoming("ขอใบเสนอราคาตรวจสุขภาพพนักงาน 50 คน");
  assert.deepEqual(conv().tags, ["B2B บริษัท"]);
  assert.deepEqual(events(), ["add:B2B บริษัท:rule"]);
  assert.deepEqual(calls, { chat: 0, embed: 0 });
});

test("ข้อความเข้าซ้ำ: ไม่บันทึก event ซ้ำ", async () => {
  await incoming("พนักงานเรา");
  await incoming("โรงงานเรา");
  assert.equal(state.tables.tag_events.length, 1);
});

test("ข้อความเข้าที่มีคำยกเว้น: ไม่ติด B2B", async () => {
  await incoming("ใช้บริษัทประกันได้ไหม");
  await incoming("พนักงานใช้ประกันสังคมได้ไหม");
  assert.deepEqual(conv().tags ?? [], []);
});

test('"HPV vaccine price" จากคนที่เคยพิมพ์ไทย: ไม่ติดต่างชาติ', async () => {
  await incoming("สวัสดีค่ะ สอบถามหน่อยค่ะ");
  await incoming("อยากฉีดวัคซีน");
  replies.next = { language: "en", th: "ราคาวัคซีน HPV" };
  await incoming("HPV vaccine price");
  assert.deepEqual(conv().tags ?? [], []);
  assert.equal(calls.chat, 1, "เรียกแค่การแปลเดิม");
});

test("ภาษาอื่นข้อความเดียว: ยังไม่ติด ข้อความที่ 2: ติด โดยไม่เรียก LLM เพิ่ม", async () => {
  replies.next = { language: "en", th: "สวัสดี" };
  await incoming("Hello, how much is the vaccine?");
  assert.deepEqual(conv().tags ?? [], []);
  await incoming("Do you open on Saturday?");
  assert.deepEqual(conv().tags, ["ต่างชาติ"]);
  assert.deepEqual(events(), ["add:ต่างชาติ:rule"]);
  assert.equal(calls.chat, 2, "แปล 2 ข้อความ ไม่เรียกเพิ่ม");
});

test("ใช้ภาษาที่ toThai ตรวจได้ ไม่ใช่การนับตัวอักษร: ภาษาไทยที่มีอังกฤษปนไม่นับ", async () => {
  await incoming("อยากฉีด HPV vaccine ค่ะ");
  await incoming("ราคา HPV เท่าไหร่คะ");
  assert.deepEqual(conv().tags ?? [], []);
  assert.equal(calls.chat, 0);
});

test("ok หรือ thanks: ไม่นับเป็นข้อความภาษาอื่น", async () => {
  replies.next = { language: "en", th: "ขอบคุณ" };
  await incoming("thanks");
  await incoming("OK");
  await incoming("Thanks!");
  assert.deepEqual(conv().tags ?? [], []);
  await incoming("Do you open on Saturday?");
  assert.deepEqual(conv().tags ?? [], [], "ข้อความจริงเพิ่งเป็นข้อความแรก");
  await incoming("How much is the vaccine?");
  assert.deepEqual(conv().tags, ["ต่างชาติ"]);
});

test("ไฟล์แนบและรูปไม่นับเป็นข้อความภาษาอื่น", async () => {
  replies.next = { language: "en", th: "สวัสดี" };
  await incoming("Hello, how much is the vaccine?");
  await storeIncoming({ channelType: "web", externalId: SESSION, text: "", isImage: true });
  await incoming("[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]");
  assert.deepEqual(conv().tags ?? [], []);
});

test("เกินเพดาน AI: ข้อความที่ไม่ได้ตรวจภาษาไม่ติดต่างชาติ", async () => {
  replies.next = { language: "en", th: "สวัสดี" };
  await incoming("Hello, how much is the vaccine?");
  await storeIncoming({ channelType: "web", externalId: SESSION, text: "Second message", skipAi: true });
  assert.deepEqual(conv().tags ?? [], []);
});

test("เจ้าหน้าที่เอาแท็กออกแล้ว: กฎและ AI ไม่ติดกลับ แต่เจ้าหน้าที่ติดเองได้", async () => {
  const s = await incoming("พนักงานเรา");
  await setConversationTag(s.conversationId, "B2B บริษัท", "remove", "staff");
  await incoming("โรงงานเราอีกครั้ง");
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
  const s = await incoming("พนักงานเรา");
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
