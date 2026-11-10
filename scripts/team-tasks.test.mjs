// งานของทีมและคอมเมนต์ภายใน: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

// นาฬิกาคงที่ให้ตรงกับนาฬิกาของ fake DB (เริ่ม 2026-11-01) ไม่ขึ้นกับวันที่รันจริง
// กติกา Meta 24 ชม./7 วัน เทียบกับ Date.now() ถ้าใช้เวลาจริงเทสต์จะล้มหลังผ่านไป 7 วัน
mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-02T06:00:00Z") });

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { autoCloseQuietChats, sendReply, storeIncoming } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const { isWaitingForReply, tabsOf } = await import("../src/lib/case-flow.ts");
const tasksRoute = await import("../src/app/api/conversations/[id]/tasks/route.ts");
const notesRoute = await import("../src/app/api/conversations/[id]/notes/route.ts");
const closeRoute = await import("../src/app/api/conversations/[id]/close/route.ts");
const webchatRoute = await import("../src/app/api/webchat/route.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const SECRET_NOTE = "บันทึกลับ: ลูกค้าคนนี้ค้างชำระ 500 บาท";
const realFetch = globalThis.fetch;
let outbound;

beforeEach(() => {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [
      { id: "web", type: "web", name: "เว็บไซต์", ai_mode: null, enabled: true, created_at: nextTime() },
      { id: "fb", type: "facebook", name: "Facebook", ai_mode: null, enabled: true, created_at: nextTime() },
    ],
    contacts: [], conversations: [], tags: [], tag_rules: [], tag_events: [], reply_examples: [], bookings: [],
    knowledge_items: [], lab_items: [], lab_packages: [], chat_tasks: [], chat_notes: [], score_events: [], response_events: [],
    staff: [
      { id: "s1", role: "agent", active: true, display_name: "เอ", can_view_sensitive: false, must_change_password: false },
      { id: "s2", role: "agent", active: true, display_name: "บี", can_view_sensitive: false, must_change_password: false },
      { id: "s3", role: "agent", active: false, display_name: "ซี", can_view_sensitive: false, must_change_password: false },
      { id: "adm", role: "admin", active: true, display_name: "แอดมิน", can_view_sensitive: true, must_change_password: false },
    ],
  });
  state.currentUser = { id: "s1", email: "a@test" };
  outbound = [];
  globalThis.fetch = async (url, init) => {
    outbound.push(`${url} ${init?.body ?? ""}`);
    return new Response(JSON.stringify({ message_id: `m_${outbound.length}` }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const json = (method, body) => new Request("https://app.test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const conv = () => state.tables.conversations[0];
const say = (text, channelType = "web", externalId = SESSION) => storeIncoming({ channelType, externalId, text });
const reply = (body) => state.tables.messages.push({
  id: `out-${state.tables.messages.length}`, conversation_id: conv().id, direction: "out", sender_type: "staff",
  body, body_th: body, imported: false, created_at: nextTime(),
});
const addTask = async (id, text = "โทรยืนยันนัด", extra = {}) => (await tasksRoute.POST(json("POST", { text, ...extra }), ctx(id)));
const tick = (id, taskId, done) => tasksRoute.PATCH(json("PATCH", { task_id: taskId, done }), ctx(id));

// ---- เพิ่มงาน / ติ๊ก ----
test("เพิ่มงาน: บันทึกผู้สร้าง ผู้รับ และนับงานค้างที่แชท", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  const res = await addTask(conversationId, "  ส่งใบเสนอราคา  ", { assignee_id: "s2" });
  assert.equal(res.status, 200);
  const { task } = await res.json();
  assert.deepEqual([task.text, task.assignee_id, task.created_by, task.done], ["ส่งใบเสนอราคา", "s2", "s1", false]);
  assert.equal(conv().open_tasks, 1);
});

for (const [label, body, status] of [
  ["ข้อความว่าง", { text: "   " }, 400],
  ["ยาวเกิน 500", { text: "ก".repeat(501) }, 400],
  ["ผู้รับปิดบัญชีแล้ว", { text: "งาน", assignee_id: "s3" }, 400],
  ["ผู้รับไม่มีอยู่", { text: "งาน", assignee_id: "ghost" }, 400],
]) {
  test(`เพิ่มงานไม่ได้: ${label}`, async () => {
    const { conversationId } = await say("สอบถามค่ะ");
    assert.equal((await tasksRoute.POST(json("POST", body), ctx(conversationId))).status, status);
    assert.equal(state.tables.chat_tasks.length, 0);
  });
}

test("ติ๊กเสร็จบันทึกคนและเวลา ยกเลิกติ๊กล้างทั้งคู่", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  const { task } = await (await addTask(conversationId)).json();
  state.currentUser = { id: "s2", email: "b@test" };
  const done = await (await tick(conversationId, task.id, true)).json();
  assert.equal(done.task.done_by, "s2");
  assert.ok(done.task.done_at);
  assert.equal(conv().open_tasks, 0);
  const undone = await (await tick(conversationId, task.id, false)).json();
  assert.deepEqual([undone.task.done, undone.task.done_by, undone.task.done_at], [false, null, null]);
  assert.equal(conv().open_tasks, 1);
});

test("ติ๊กงานของแชทอื่นไม่ได้", async () => {
  const a = await say("แชท A");
  const { task } = await (await addTask(a.conversationId)).json();
  const b = await say("แชท B", "web", "22222222-2222-4222-8222-222222222222");
  assert.equal((await tick(b.conversationId, task.id, true)).status, 404);
});

// ---- กติกาเสร็จแล้ว (server) ----
test("กดเสร็จแล้วไม่ได้ถ้ายังมีงานไม่ติ๊ก: server ตอบ 409 พร้อมจำนวนงาน", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  await addTask(conversationId, "งาน 1");
  await addTask(conversationId, "งาน 2");
  const res = await closeRoute.POST(json("POST"), ctx(conversationId));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "เหลือ 2 งานที่ยังไม่เสร็จ");
  assert.equal(body.open_tasks, 2);
  assert.equal(conv().status, "open");
});

test("ติ๊กครบแล้วกดเสร็จแล้วได้", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  const { task } = await (await addTask(conversationId)).json();
  await tick(conversationId, task.id, true);
  assert.equal((await closeRoute.POST(json("POST"), ctx(conversationId))).status, 200);
  assert.equal(conv().status, "closed");
});

// ---- ย้ายไปเสร็จแล้วอัตโนมัติ ----
test("ลูกค้าตอบโอเค/สติกเกอร์: แชทที่มีงานค้างไม่ถูกปิด และยังอยู่ในรอตอบ", async () => {
  const { conversationId } = await say("เปิดกี่โมงคะ");
  reply("เปิด 08.00 น. ค่ะ");
  await addTask(conversationId, "โทรกลับ");
  await say("โอเคค่ะ");
  assert.equal(conv().status, "open");
  await say("[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]");
  assert.equal(conv().status, "open");
  assert.ok(isWaitingForReply(conv()));
});

test("ลูกค้าตอบโอเค ไม่มีงานค้าง: ปิดเหมือนเดิม", async () => {
  await say("เปิดกี่โมงคะ");
  reply("เปิด 08.00 น. ค่ะ");
  await say("โอเคค่ะ");
  assert.equal(conv().status, "closed");
});

test("ย้ายไปเสร็จแล้วเมื่อเงียบเกินกำหนด: ข้ามแชทที่มีงานค้าง", async () => {
  const a = await say("แชท A");
  reply("ตอบแล้วค่ะ");
  const b = await say("แชท B", "web", "22222222-2222-4222-8222-222222222222");
  state.tables.messages.push({ id: "ob", conversation_id: b.conversationId, direction: "out", sender_type: "staff", body: "ตอบแล้ว", created_at: nextTime() });
  await addTask(b.conversationId, "ส่งผลตรวจ");
  for (const c of state.tables.conversations) Object.assign(c, { last_message_at: "2026-01-01T00:00:00Z", last_direction: "out", needs_human: false });
  const closed = await autoCloseQuietChats(Date.parse("2026-01-05T00:00:00Z"));
  assert.equal(closed, 1);
  assert.equal(state.tables.conversations.find((c) => c.id === a.conversationId).status, "closed");
  assert.equal(state.tables.conversations.find((c) => c.id === b.conversationId).status, "open");
});

// ---- เปิดแชทกลับมา ----
test("เพิ่มงานในแชทที่เสร็จแล้ว: กลับมารอตอบ", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  reply("ได้ค่ะ");
  Object.assign(conv(), { status: "closed", last_direction: "out" });
  await addTask(conversationId, "ตามผลแล็บ");
  assert.equal(conv().status, "open");
  assert.deepEqual(tabsOf(conv()), ["open", "waiting"]);
});

test("ยกเลิกติ๊กในแชทที่เสร็จแล้ว: กลับมารอตอบ / ติ๊กเสร็จไม่เปิด", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  reply("ได้ค่ะ");
  const { task } = await (await addTask(conversationId)).json();
  await tick(conversationId, task.id, true);
  await closeRoute.POST(json("POST"), ctx(conversationId));
  assert.equal(conv().status, "closed");
  await tick(conversationId, task.id, true);
  assert.equal(conv().status, "closed", "ติ๊กซ้ำไม่เปิดแชท");
  await tick(conversationId, task.id, false);
  assert.equal(conv().status, "open");
  assert.ok(isWaitingForReply(conv()));
});

test("คอมเมนต์ไม่เปิดแชทที่เสร็จแล้ว", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  Object.assign(conv(), { status: "closed" });
  await notesRoute.POST(json("POST", { body: "หมายเหตุ" }), ctx(conversationId));
  assert.equal(conv().status, "closed");
});

// ---- คอมเมนต์ ----
test("คอมเมนต์ภายในของแชทและของงาน: บันทึกผู้เขียน", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  const { task } = await (await addTask(conversationId)).json();
  const a = await (await notesRoute.POST(json("POST", { body: "ลูกค้าขอให้โทรช่วงเย็น" }), ctx(conversationId))).json();
  const b = await (await notesRoute.POST(json("POST", { body: "โทรแล้ว ไม่รับ", task_id: task.id }), ctx(conversationId))).json();
  assert.deepEqual([a.note.task_id, a.note.author_id], [null, "s1"]);
  assert.equal(b.note.task_id, task.id);
  assert.equal((await notesRoute.POST(json("POST", { body: " " }), ctx(conversationId))).status, 400);
  const other = await say("แชทอื่น", "web", "22222222-2222-4222-8222-222222222222");
  assert.equal((await notesRoute.POST(json("POST", { body: "x", task_id: task.id }), ctx(other.conversationId))).status, 404);
});

test("คอมเมนต์ภายในไม่ออกไปทางช่องทางส่งข้อความ ไม่อยู่ใน widget และไม่อยู่ใน prompt ของ AI", async () => {
  const fb = await say("ราคาเท่าไหร่คะ", "facebook", "psid-1");
  await notesRoute.POST(json("POST", { body: SECRET_NOTE }), ctx(fb.conversationId));
  const { task } = await (await addTask(fb.conversationId, "เช็กยอดค้าง")).json();
  await notesRoute.POST(json("POST", { body: SECRET_NOTE, task_id: task.id }), ctx(fb.conversationId));
  await sendReply({ conversationId: fb.conversationId, textTh: "เข็มละ 390 บาทค่ะ", senderType: "staff", senderId: "s1", skipLearn: true });
  assert.ok(outbound.length > 0, "ส่งข้อความจริงผ่าน Meta");
  assert.ok(outbound.every((o) => !o.includes("ค้างชำระ")), "ไม่มีคอมเมนต์ในสิ่งที่ส่งออก");
  assert.ok(state.tables.messages.every((m) => !String(m.body).includes("ค้างชำระ")), "คอมเมนต์ไม่ถูกเก็บเป็นข้อความแชท");

  replies.next = { needs_human: false, suggested_tags: [], options: [{ text: "ร่าง", source: "knowledge", ref_ids: [], confidence: 0.8 }] };
  await say("แล้วเด็กฉีดได้ไหม", "facebook", "psid-1");
  await generateSuggestions(fb.conversationId, { force: true });
  assert.equal(calls.chat, 1);
  assert.doesNotMatch(calls.lastPrompt, /ค้างชำระ|เช็กยอดค้าง/);

  const web = await say("สวัสดีค่ะ");
  await notesRoute.POST(json("POST", { body: SECRET_NOTE }), ctx(web.conversationId));
  const res = await webchatRoute.GET(new Request(`https://app.test/api/webchat?session=${SESSION}`, { headers: { origin: "https://happiwellclinic.com" } }));
  const body = JSON.stringify(await res.json());
  assert.doesNotMatch(body, /ค้างชำระ/);
  assert.match(body, /สวัสดีค่ะ/);
});

test("เส้นทางที่ส่งถึงลูกค้าและ AI ไม่อ่านตารางงานหรือคอมเมนต์เลย", () => {
  for (const f of ["src/lib/pipeline.ts", "src/lib/suggest.ts", "src/lib/channels/index.ts", "src/lib/channels/line.ts", "src/lib/channels/meta.ts", "src/app/api/webchat/route.ts", "src/lib/media-store.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /chat_notes|chat_tasks/, f);
  }
});

// ---- แชทลับ ----
test("แชทลับ: เจ้าหน้าที่ที่ไม่มีสิทธิ์เพิ่มงานหรือคอมเมนต์ไม่ได้ และมอบงานให้คนไม่มีสิทธิ์ไม่ได้", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  conv().sensitive = true;
  assert.equal((await addTask(conversationId)).status, 403);
  assert.equal((await notesRoute.POST(json("POST", { body: "x" }), ctx(conversationId))).status, 403);
  state.currentUser = { id: "adm", email: "adm@test" };
  assert.equal((await addTask(conversationId, "งาน", { assignee_id: "s2" })).status, 400);
  assert.equal((await addTask(conversationId, "งาน", { assignee_id: "adm" })).status, 200);
});

test("ไม่ล็อกอิน: 401", async () => {
  const { conversationId } = await say("สอบถามค่ะ");
  state.currentUser = null;
  assert.equal((await addTask(conversationId)).status, 401);
  assert.equal((await notesRoute.POST(json("POST", { body: "x" }), ctx(conversationId))).status, 401);
});

// ---- migration ----
test("migration 035: ลบตามแชท, RLS อ่านตามสิทธิ์แชท, ไม่มี policy เขียน, คอมเมนต์ผูกงานในแชทเดียวกัน", () => {
  const sql = readFileSync("supabase/migrations/035_team_tasks.sql", "utf8");
  assert.equal((sql.match(/references conversations\(id\) on delete cascade/g) ?? []).length, 2);
  assert.match(sql, /foreign key \(task_id, conversation_id\) references chat_tasks \(id, conversation_id\) on delete cascade/);
  assert.match(sql, /create policy staff_read on chat_tasks for select to authenticated using \(can_read_conversation\(conversation_id\)\)/);
  assert.match(sql, /create policy staff_read on chat_notes for select to authenticated using \(can_read_conversation\(conversation_id\)\)/);
  assert.doesNotMatch(sql, /for (insert|update|delete|all)/i);
  assert.match(sql, /revoke all on chat_notes from anon, authenticated/);
  assert.doesNotMatch(sql, /grant [^;]* to anon/i);
  assert.match(sql, /add column if not exists open_tasks integer not null default 0/);
});

// ---- เมนูซ้าย ----
