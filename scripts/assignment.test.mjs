// ทดสอบผู้ดูแลแชท: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { sendReply, storeIncoming } = await import("../src/lib/pipeline.ts");
const { assignError, ASSIGNEE_ESCALATE_SECONDS, shouldAlertStaff, staffInitial } = await import("../src/lib/assignment.ts");
const { businessSeconds } = await import("../src/lib/business-hours.ts");
const assignRoute = await import("../src/app/api/conversations/[id]/assign/route.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const HOURS = {
  tz: "Asia/Bangkok",
  days: { 0: ["08:00", "12:00"], 1: ["08:00", "18:00"], 2: ["08:00", "18:00"], 3: ["08:00", "18:00"], 4: ["08:00", "18:00"], 5: ["08:00", "18:00"], 6: ["08:00", "12:00"] },
};
const th = (s) => `${s}+07:00`;
// 2 พ.ย. 2569 เป็นวันจันทร์
const MON = "2026-11-02";

function setup() {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [],
    conversations: [],
    staff: [
      { id: "admin", role: "admin", active: true, display_name: "Admin" },
      { id: "a", role: "agent", active: true, display_name: "ก้อย" },
      { id: "b", role: "agent", active: true, display_name: "บี" },
      { id: "off", role: "agent", active: false, display_name: "ออก" },
    ],
    tags: [], tag_rules: [], tag_events: [], assignment_log: [], reply_examples: [],
  });
  state.currentUser = { id: "a", email: "a@test" };
}
beforeEach(setup);
const conv = () => state.tables.conversations[0];
const customer = (text = "สอบถามหน่อยค่ะ") => storeIncoming({ channelType: "web", externalId: SESSION, text });
const reply = (id, senderId, senderType = "staff") => sendReply({ conversationId: id, textTh: "ได้เลยค่ะ", senderType, senderId });

// ---- สิทธิ์ ----
const ADMIN = { id: "admin", role: "admin" };
const AGENT = { id: "a", role: "agent" };

test("admin เปลี่ยนได้ทุกกรณี", () => {
  assert.equal(assignError(ADMIN, null, "a"), null);
  assert.equal(assignError(ADMIN, "b", "a"), null);
  assert.equal(assignError(ADMIN, "b", null), null);
});

test("agent รับเคสที่ไม่มีผู้ดูแลได้เฉพาะให้ตัวเอง", () => {
  assert.equal(assignError(AGENT, null, "a"), null);
  assert.match(assignError(AGENT, null, "b"), /ตัวเอง/);
});

test("agent ส่งต่อเคสของตัวเองได้ แต่ทำให้ไม่มีผู้ดูแลไม่ได้", () => {
  assert.equal(assignError(AGENT, "a", "b"), null);
  assert.match(assignError(AGENT, "a", null), /ผู้รับ/);
});

test("agent เปลี่ยนผู้ดูแลของแชทคนอื่นไม่ได้", () => {
  assert.match(assignError(AGENT, "b", "a"), /คนอื่น/);
  assert.match(assignError(AGENT, "b", null), /คนอื่น/);
});

// ---- API ----
const post = (id, body) => assignRoute.POST(
  new Request("https://app.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

test("API: agent รับเคส แล้วบันทึกประวัติ", async () => {
  const s = await customer();
  const res = await post(s.conversationId, { to: "a" });
  assert.equal(res.status, 200);
  assert.equal(conv().assigned_to, "a");
  assert.deepEqual(state.tables.assignment_log.map((l) => [l.from_staff, l.to_staff, l.by_staff]), [[null, "a", "a"]]);
});

test("API: agent แย่งเคสคนอื่น 403 และข้อมูลไม่เปลี่ยน", async () => {
  const s = await customer();
  conv().assigned_to = "b";
  assert.equal((await post(s.conversationId, { to: "a" })).status, 403);
  assert.equal(conv().assigned_to, "b");
  assert.equal(state.tables.assignment_log.length, 0);
});

test("API: ส่งต่อให้บัญชีที่ปิดหรือไม่มีจริงไม่ได้", async () => {
  const s = await customer();
  conv().assigned_to = "a";
  assert.equal((await post(s.conversationId, { to: "off" })).status, 400);
  assert.equal((await post(s.conversationId, { to: "ghost" })).status, 400);
  assert.equal(conv().assigned_to, "a");
});

test("API: ส่งต่อ แล้วบันทึกผู้ส่งต่อ", async () => {
  const s = await customer();
  conv().assigned_to = "a";
  await post(s.conversationId, { to: "b" });
  assert.deepEqual(state.tables.assignment_log.at(-1), { conversation_id: s.conversationId, from_staff: "a", to_staff: "b", by_staff: "a" });
});

test("API: ไม่ได้ล็อกอิน 401, ไม่ส่งผู้รับ 400, ไม่พบแชท 404", async () => {
  const s = await customer();
  assert.equal((await post(s.conversationId, {})).status, 400);
  assert.equal((await post("missing", { to: "a" })).status, 404);
  state.currentUser = null;
  assert.equal((await post(s.conversationId, { to: "a" })).status, 401);
});

// ---- อัตโนมัติ ----
test("เจ้าหน้าที่ตอบแชทที่ไม่มีผู้ดูแล: เป็นผู้ดูแลอัตโนมัติ", async () => {
  const s = await customer();
  await reply(s.conversationId, "a");
  assert.equal(conv().assigned_to, "a");
  assert.equal(state.tables.assignment_log.length, 1);
});

test("ตอบแชทที่มีผู้ดูแลแล้ว: ผู้ดูแลไม่เปลี่ยน", async () => {
  const s = await customer();
  conv().assigned_to = "b";
  await reply(s.conversationId, "a");
  assert.equal(conv().assigned_to, "b");
  assert.equal(state.tables.assignment_log.length, 0);
});

test("AI ตอบ: ไม่กลายเป็นผู้ดูแล", async () => {
  const s = await customer();
  await reply(s.conversationId, undefined, "ai");
  assert.equal(conv().assigned_to ?? null, null);
});

test("กดเสร็จแล้วผู้ดูแลยังอยู่ ลูกค้าทักกลับไปหาคนเดิม", async () => {
  const s = await customer();
  await reply(s.conversationId, "a");
  conv().status = "closed";
  await customer("สอบถามเพิ่มค่ะ");
  assert.equal(conv().status, "open");
  assert.equal(conv().assigned_to, "a");
});

// ---- เสียงเตือน ----
const chat = (assigned_to, waiting_since) => ({ assigned_to, waiting_since, last_inbound_at: waiting_since });

test("แชทไม่มีผู้ดูแล: เตือนทุกคน", () => {
  assert.equal(shouldAlertStaff(chat(null, th(`${MON}T10:00:00`)), "a", HOURS, Date.parse(th(`${MON}T10:00:01`))), true);
});

test("แชทของเรา: เตือนทันที", () => {
  assert.equal(shouldAlertStaff(chat("a", th(`${MON}T10:00:00`)), "a", HOURS, Date.parse(th(`${MON}T10:00:01`))), true);
});

test("แชทของคนอื่น: เตือนเมื่อเกิน 10 นาทีในเวลาทำการ", () => {
  const c = chat("b", th(`${MON}T10:00:00`));
  assert.equal(ASSIGNEE_ESCALATE_SECONDS, 600);
  assert.equal(shouldAlertStaff(c, "a", HOURS, Date.parse(th(`${MON}T10:10:00`))), false);
  assert.equal(shouldAlertStaff(c, "a", HOURS, Date.parse(th(`${MON}T10:10:01`))), true);
});

test("แชทของคนอื่นนอกเวลาทำการ: ไม่เตือน จนกว่าจะเปิดทำการครบ 10 นาที", () => {
  const c = chat("b", th(`${MON}T22:00:00`));
  assert.equal(shouldAlertStaff(c, "a", HOURS, Date.parse(th("2026-11-03T07:00:00"))), false);
  assert.equal(shouldAlertStaff(c, "a", HOURS, Date.parse(th("2026-11-03T08:10:00"))), false);
  assert.equal(shouldAlertStaff(c, "a", HOURS, Date.parse(th("2026-11-03T08:10:01"))), true);
});

test("ตัวอักษรย่อ", () => {
  assert.equal(staffInitial("admin"), "A");
  assert.equal(staffInitial(" ก้อย"), "ก");
  assert.equal(staffInitial(null), "?");
  assert.equal(staffInitial(""), "?");
});

// ---- เวลาทำการ ----
const bs = (a, b, h = HOURS) => businessSeconds(th(a), th(b), h);

test("เวลาทำการ: ในเวลาเดียวกันนับเท่าเวลาจริง", () => {
  assert.equal(bs(`${MON}T10:00:00`, `${MON}T10:05:00`), 300);
});

test("เวลาทำการ: ทักก่อนเปิด เริ่มนับตอนเปิด", () => {
  assert.equal(bs(`${MON}T06:00:00`, `${MON}T08:02:00`), 120);
  assert.equal(bs(`${MON}T06:00:00`, `${MON}T07:59:00`), 0);
});

test("เวลาทำการ: ทักก่อนปิด ตอบวันรุ่งขึ้น นับเฉพาะช่วงเปิด", () => {
  assert.equal(bs(`${MON}T17:59:00`, "2026-11-03T08:01:00"), 120);
});

test("เวลาทำการ: ข้ามวันหยุด (ปิดทั้งวัน)", () => {
  const h = { tz: "Asia/Bangkok", days: { 1: ["08:00", "18:00"], 3: ["08:00", "18:00"] } };
  assert.equal(bs(`${MON}T17:59:00`, "2026-11-04T08:01:00", h), 120);
});

test("เวลาทำการ: เสาร์-อาทิตย์ปิดเที่ยงตามค่าตั้ง", () => {
  // 7 พ.ย. 2569 เป็นวันเสาร์
  assert.equal(bs("2026-11-07T13:00:00", "2026-11-07T15:00:00"), 0);
  assert.equal(bs("2026-11-07T11:59:00", "2026-11-07T15:00:00"), 60);
});

test("เวลาทำการ: ปลายทางก่อนต้นทางเป็น 0 และไม่ได้ตั้งเวลาใช้เวลาจริง", () => {
  assert.equal(bs(`${MON}T10:05:00`, `${MON}T10:00:00`), 0);
  assert.equal(bs(`${MON}T22:00:00`, `${MON}T22:05:00`, { tz: "Asia/Bangkok", days: {} }), 300);
});
