// ทดสอบการนำเข้าแบบวางข้อความ ใช้ข้อมูลจำลองเท่านั้น: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { resetDb, state } = await import(fake("admin"));
const { buildPastePairs, maskPastedShape, parsePastedChat } = await import("../src/lib/paste-import.ts");
const route = await import("../src/app/api/imports/paste/route.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");

const line = (sender, text) => ({ sender, text });
const post = (body) => new Request("https://a.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("แยกบรรทัด: ตัดบรรทัดว่าง ข้ามเวลาและสถานะอ่าน ไม่เดาผู้ส่ง", () => {
  const lines = parsePastedChat("ถามจำลอง\n\n10:30\nอ่านแล้ว\n  ตอบจำลอง  \r\nเมื่อวาน");
  assert.deepEqual(lines.map((l) => [l.text, l.sender]), [["ถามจำลอง", "unknown"], ["10:30", "skip"], ["อ่านแล้ว", "skip"], ["ตอบจำลอง", "unknown"], ["เมื่อวาน", "skip"]]);
});

test("โครงสร้างไม่มีเนื้อหา", () => {
  const out = maskPastedShape("สวัสดี Somchai 10:30 น.\n081-234-5678 😊");
  assert.doesNotMatch(out, /สวัสดี|Somchai|081/);
  assert.equal(out, "ก a 99:99 ก.\n999-999-9999 ??");
});

test("คู่: รวมบรรทัดต่อเนื่องของแต่ละฝั่ง", () => {
  assert.deepEqual(buildPastePairs([line("customer", "สวัสดี"), line("customer", "ถามหน่อย"), line("clinic", "ได้ค่ะ"), line("clinic", "ตอบต่อค่ะ")]),
    [{ question: "สวัสดี\nถามหน่อย", answer: "ได้ค่ะ\nตอบต่อค่ะ" }]);
});

test("คู่: หลายรอบ และคลินิกทักก่อนไม่นับ", () => {
  const p = buildPastePairs([line("clinic", "ทักทายก่อน"), line("customer", "ถามหนึ่ง"), line("clinic", "ตอบหนึ่งค่ะ"), line("customer", "ถามสอง"), line("clinic", "ตอบสองค่ะ")]);
  assert.deepEqual(p.map((x) => x.question), ["ถามหนึ่ง", "ถามสอง"]);
});

test("คู่: บรรทัดไม่ระบุตัดคู่ ไม่เดา บรรทัดข้ามไม่ตัด", () => {
  assert.equal(buildPastePairs([line("customer", "ถามหน่อย"), line("unknown", "ไม่รู้"), line("clinic", "ตอบค่ะนะ")]).length, 0);
  assert.equal(buildPastePairs([line("customer", "ถามหน่อย"), line("skip", "10:30"), line("clinic", "ตอบค่ะนะ")]).length, 1);
});

test("คู่: คำตอบสั้นกว่า 4 ตัวข้าม และลบข้อมูลส่วนตัว", () => {
  assert.equal(buildPastePairs([line("customer", "ถามหน่อย"), line("clinic", "ได้")]).length, 0);
  const [p] = buildPastePairs([line("customer", "เบอร์ 081-234-5678"), line("clinic", "รับทราบค่ะ")]);
  assert.match(p.question, /\[เบอร์โทร\]/);
});

// ---- API ----
function setup() {
  reset();
  resetDb({
    reply_examples: [], staff: [{ id: "admin", role: "admin", active: true, display_name: "A" }, { id: "agent", role: "agent", active: true, display_name: "B" }],
    settings: [{ key: "ai_mode", value: "off" }], tags: [], knowledge_items: [], lab_items: [], lab_packages: [], bookings: [],
    conversations: [{ id: "conv", tags: [], status: "open" }],
  });
  state.currentUser = { id: "admin", email: "a@test" };
}
beforeEach(setup);
const PAIR = { question: "วัคซีนจำลองราคาเท่าไหร่", answer: "เข็มละ 111 บาทค่ะ" };

test("บันทึก: source manual_paste ติดดาวได้ มี embedding", async () => {
  const res = await route.POST(post({ pairs: [{ ...PAIR, starred: true }] }));
  assert.deepEqual(await res.json(), { saved: 1, duplicates: 0, invalid: 0, sensitive: 0 });
  const e = state.tables.reply_examples[0];
  assert.deepEqual([e.source, e.starred, e.question, e.answer, e.created_by], ["manual_paste", true, PAIR.question, PAIR.answer, "admin"]);
  assert.ok(e.embedding && e.import_hash);
});

test("server ลบข้อมูลส่วนตัวซ้ำ แม้แก้คำตอบเพิ่มเบอร์เข้าไป", async () => {
  await route.POST(post({ pairs: [{ question: PAIR.question, answer: "โทรหา 081-234-5678 นะคะ" }] }));
  assert.doesNotMatch(state.tables.reply_examples[0].answer, /081/);
});

test("ไม่สร้างประวัติแชทหรือแตะลูกค้า", async () => {
  await route.POST(post({ pairs: [PAIR] }));
  assert.equal(state.tables.messages.length, 0);
  assert.equal(state.tables.contacts, undefined);
});

test("กันซ้ำ: ไฟล์เดียวกันและครั้งถัดไป ไม่เรียก embedding ซ้ำ", async () => {
  await route.POST(post({ pairs: [PAIR, PAIR] }));
  assert.equal(state.tables.reply_examples.length, 1);
  const before = calls.embed;
  const again = await (await route.POST(post({ pairs: [PAIR] }))).json();
  assert.deepEqual(again, { saved: 0, duplicates: 1, invalid: 0, sensitive: 0 });
  assert.equal(calls.embed, before);
});

test("สั้นเกินไปไม่บันทึก ข้อมูลเสียได้ 400", async () => {
  assert.deepEqual(await (await route.POST(post({ pairs: [{ question: "ถาม", answer: "ได้" }] }))).json(), { saved: 0, duplicates: 0, invalid: 1, sensitive: 0 });
  assert.equal((await route.POST(post({ pairs: "x" }))).status, 400);
  assert.equal((await route.POST(post({ pairs: Array(201).fill(PAIR) }))).status, 400);
});

test("agent 403 ไม่ล็อกอิน 401", async () => {
  state.currentUser = { id: "agent", email: "b@test" };
  assert.equal((await route.POST(post({ pairs: [PAIR] }))).status, 403);
  state.currentUser = null;
  assert.equal((await route.POST(post({ pairs: [PAIR] }))).status, 401);
});

test("AI ไม่ใช้ตัวเลขจากคำตอบที่วางเป็นแหล่งยืนยัน", async () => {
  await route.POST(post({ pairs: [PAIR] }));
  const e = state.tables.reply_examples[0];
  state.tables.messages.push({ id: "m", conversation_id: "conv", direction: "in", sender_type: "customer", body: "วัคซีนราคาเท่าไหร่", created_at: "2026-10-02T03:00:00.000Z" });
  state.matchExamples = [{ id: e.id, question: e.question, answer: e.answer, starred: false, use_count: 0, created_at: "2026-10-01T00:00:00Z", similarity: 0.9 }];
  replies.next = { needs_human: false, suggested_tags: [], options: [{ text: "เข็มละ 111 บาทค่ะ", source: "example", ref_ids: [], confidence: 0.95 }] };
  const s = await generateSuggestions("conv");
  assert.ok(s.options[0].confidence <= 0.5);
});
