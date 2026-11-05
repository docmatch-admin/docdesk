// หน้าแชทแบบกระชับ แผงขวา และนัดหมายที่ทำจากแชท: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { storeIncoming, setConversationTag } = await import("../src/lib/pipeline.ts");
const bookingsRoute = await import("../src/app/api/conversations/[id]/bookings/route.ts");
const cancelRoute = await import("../src/app/api/bookings/[id]/cancel/route.ts");
const closeRoute = await import("../src/app/api/conversations/[id]/close/route.ts");
const tasksRoute = await import("../src/app/api/conversations/[id]/tasks/route.ts");
const tagsRoute = await import("../src/app/api/conversations/[id]/tags/route.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "web", type: "web", name: "เว็บไซต์", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: [{ id: "t1", name: "นัดแล้ว", group: "status", active: true }, { id: "t2", name: "วัคซีน", group: "topic", active: true }],
    tag_rules: [], tag_events: [], reply_examples: [], bookings: [], chat_tasks: [], chat_notes: [], score_events: [], response_events: [],
    knowledge_items: [], lab_items: [], lab_packages: [],
    staff: [
      { id: "s1", role: "agent", active: true, display_name: "เอ", can_view_sensitive: false, must_change_password: false },
      { id: "adm", role: "admin", active: true, display_name: "แอดมิน", can_view_sensitive: true, must_change_password: false },
    ],
  });
  state.currentUser = { id: "s1", email: "a@test" };
});

const json = (method, body) => new Request("https://app.test/x", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const conv = () => state.tables.conversations[0];
const say = (text) => storeIncoming({ channelType: "web", externalId: SESSION, text });
const NEW = { service: "ตรวจเลือด", date: "2030-01-03", time: "08:30", name: "คุณทดสอบ", phone: "0812345678" };

// ---- ทำนัดจากแชท ----
test("ทำนัดใหม่จากแชท: บันทึกเป็นลงนัดแล้ว ไม่ติดลงนัดก่อน และติดแท็กนัดแล้ว", async () => {
  const { conversationId } = await say("ขอนัดค่ะ");
  const res = await bookingsRoute.POST(json("POST", NEW), ctx(conversationId));
  assert.equal(res.status, 200);
  const b = state.tables.bookings[0];
  assert.deepEqual([b.service, b.date, b.time.slice(0, 5), b.status, b.recorded_by], ["ตรวจเลือด", "2030-01-03", "08:30", "recorded", "s1"]);
  assert.ok(b.recorded_at);
  assert.equal(conv().booking_pending, false);
  assert.ok(conv().tags.includes("นัดแล้ว"));
  assert.equal((await closeRoute.POST(json("POST"), ctx(conversationId))).status, 200);
});

for (const [label, body] of [
  ["ไม่มีบริการ", { ...NEW, service: " " }],
  ["วันที่ผิด", { ...NEW, date: "3 มกรา" }],
  ["เวลาผิด", { ...NEW, time: "25:00" }],
]) {
  test(`ทำนัดไม่ได้: ${label}`, async () => {
    const { conversationId } = await say("ขอนัดค่ะ");
    assert.equal((await bookingsRoute.POST(json("POST", body), ctx(conversationId))).status, 400);
    assert.equal(state.tables.bookings.length, 0);
  });
}

test("ทำนัดในแชทลับ: คนไม่มีสิทธิ์ทำไม่ได้", async () => {
  const { conversationId } = await say("ขอนัดค่ะ");
  conv().sensitive = true;
  assert.equal((await bookingsRoute.POST(json("POST", NEW), ctx(conversationId))).status, 403);
  state.currentUser = { id: "adm", email: "adm@test" };
  assert.equal((await bookingsRoute.POST(json("POST", NEW), ctx(conversationId))).status, 200);
});

// ---- ยกเลิกนัด ----
test("ยกเลิกนัดที่รอลงนัด: ปลดลงนัดก่อน แล้วกดเสร็จแล้วได้ / ยกเลิกซ้ำได้ 409", async () => {
  const { conversationId } = await say("ขอนัดค่ะ");
  state.tables.bookings.push({ id: "bk1", conversation_id: conversationId, service: "วัคซีน", date: "2030-01-03", time: "09:00:00", status: "ai_confirmed", created_at: nextTime() });
  conv().booking_pending = true;
  assert.equal((await closeRoute.POST(json("POST"), ctx(conversationId))).status, 409);
  assert.equal((await cancelRoute.POST(json("POST"), ctx("bk1"))).status, 200);
  assert.equal(state.tables.bookings[0].status, "cancelled");
  assert.equal(conv().booking_pending, false);
  assert.equal((await cancelRoute.POST(json("POST"), ctx("bk1"))).status, 409);
  assert.equal((await closeRoute.POST(json("POST"), ctx(conversationId))).status, 200);
});

test("ยกเลิกนัดไม่ส่งข้อความถึงลูกค้า", async () => {
  const { conversationId } = await say("ขอนัดค่ะ");
  state.tables.bookings.push({ id: "bk1", conversation_id: conversationId, service: "วัคซีน", date: "2030-01-03", time: "09:00:00", status: "recorded", created_at: nextTime() });
  const before = state.tables.messages.length;
  await cancelRoute.POST(json("POST"), ctx("bk1"));
  assert.equal(state.tables.messages.length, before);
});

test("ยกเลิกนัดในแชทลับ: คนไม่มีสิทธิ์ทำไม่ได้ / ไม่พบนัด 404", async () => {
  const { conversationId } = await say("ขอนัดค่ะ");
  conv().sensitive = true;
  state.tables.bookings.push({ id: "bk1", conversation_id: conversationId, service: "x", date: "2030-01-03", time: "09:00:00", status: "recorded", created_at: nextTime() });
  assert.equal((await cancelRoute.POST(json("POST"), ctx("bk1"))).status, 403);
  assert.equal((await cancelRoute.POST(json("POST"), ctx("missing"))).status, 404);
});

// ---- กติกาเสร็จแล้ว ----
test("กดเสร็จแล้ว: นัดรอลงนัดหรืองานค้าง อย่างใดอย่างหนึ่งก็ปิดไม่ได้", async () => {
  const { conversationId } = await say("ขอนัดค่ะ");
  const { task } = await (await tasksRoute.POST(json("POST", { text: "โทรยืนยัน" }), ctx(conversationId))).json();
  conv().booking_pending = true;
  const r1 = await closeRoute.POST(json("POST"), ctx(conversationId));
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).error, "ลงนัดก่อน");
  conv().booking_pending = false;
  const r2 = await closeRoute.POST(json("POST"), ctx(conversationId));
  assert.equal((await r2.json()).error, "เหลือ 1 งานที่ยังไม่เสร็จ");
  await tasksRoute.PATCH(json("PATCH", { task_id: task.id, done: true }), ctx(conversationId));
  assert.equal((await closeRoute.POST(json("POST"), ctx(conversationId))).status, 200);
});

// ---- ที่มาของแท็ก ----
test("ที่มาของแท็ก: AI / staff ส่งให้ทุกคนที่อ่านแชทได้ แชทลับต้องมีสิทธิ์", async () => {
  const { conversationId } = await say("ฉีดวัคซีนค่ะ");
  await setConversationTag(conversationId, "วัคซีน", "add", "ai");
  await setConversationTag(conversationId, "นัดแล้ว", "add", "staff");
  const r = await (await tagsRoute.GET(new Request("https://app.test/x"), ctx(conversationId))).json();
  assert.deepEqual(r.sources, { "วัคซีน": "ai", "นัดแล้ว": "staff" });
  conv().sensitive = true;
  assert.equal((await tagsRoute.GET(new Request("https://app.test/x"), ctx(conversationId))).status, 403);
});

// ---- โครงหน้า ----
const inbox = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
const header = inbox.slice(inbox.indexOf('<header className="chat-head compact">'), inbox.indexOf("</header>"));
const panelStart = inbox.indexOf('<aside className="team-panel"');
const panel = inbox.slice(panelStart, inbox.indexOf("</aside>", panelStart));

test("หัวแชท: แถวเดียว มีผู้ดูแลและปุ่มเสร็จแล้ว ไม่มีแท็ก โหมด AI แชทลับ เปิดใหม่ หรือแยกประวัติ", () => {
  assert.match(header, /AssigneeControl/);
  assert.match(header, /<Icon name="check" \/> เสร็จแล้ว/);
  assert.match(header, /aria-label="แก้ชื่อลูกค้า"/);
  for (const gone of ["TagPicker", "TagChip", "AI_MODE_LABEL", "setSensitive", "reopenCase", "splitImported", "เหลือ"]) {
    assert.ok(!header.includes(gone), `ยังมี ${gone} ในหัวแชท`);
  }
});

test("ปุ่มเสร็จแล้วปิดเมื่อมีนัดรอลงหรืองานค้าง และบอกเหตุผลในแถบสถานะ", () => {
  assert.match(inbox, /const doneHint = selected\?\.booking_pending \? "ลงนัดก่อน" : openTasks > 0 \? `เหลือ \$\{openTasks\} งานที่ยังไม่เสร็จ` : "";/);
  assert.match(header, /title=\{doneHint \|\| "Ctrl\+Shift\+E"\} disabled=\{doneBlocked\}/);
  assert.match(inbox, /<div className="status-strip" role="status">[\s\S]{0,400}\{doneHint && selected\.status === "open" && <span id="done-hint"/);
});

test("แผงขวา: แท็ก → AI/กุญแจ → นัดหมาย → งานของทีม (มีคอมเมนต์ภายในอยู่ในนั้น)", () => {
  const order = ["TagPicker", 'aria-label="AI แชทนี้"', "BookingsBlock", "TeamPanel"].map((k) => panel.indexOf(k));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(panel, /ai=\{tagSources\[t\] === "ai"\}/);
  assert.match(panel, /aria-label="ตั้งเป็นแชทลับ"/);
});

test("แถบแดงและขั้นตอนรับทราบแชทลับยังอยู่ตรงกลาง ไม่ย้ายไปแผงขวา", () => {
  assert.match(inbox, /<div className="sensitive-banner" role="alert">/);
  assert.match(inbox, /<div className="sensitive-ack card">/);
  assert.ok(!panel.includes("sensitive-banner") && !panel.includes("sensitive-ack"));
  assert.match(inbox, /\{selected && !locked && \(\s*<aside className="team-panel"/);
});

test("ปุ่มไอคอนทุกตัวมี aria-label และ title และไม่มี emoji ในเมนูกับแผงขวา", () => {
  const files = ["src/app/(staff)/inbox/booking-card.tsx", "src/app/(staff)/inbox/team-panel.tsx", "src/app/(staff)/layout.tsx", "src/app/(staff)/nav-toggle.tsx"];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${f} มี emoji`);
    for (const m of src.matchAll(/<button[^>]*className="icon-btn[^"]*"[^>]*>/g)) {
      const tag = m[0];
      if (!/aria-label=/.test(tag)) {
        // ปุ่มที่ aria-label อยู่บรรทัดถัดไป
        const at = src.indexOf(tag);
        const tail = src.slice(at, at + 400);
        assert.match(tail, /aria-label=/, `${f}: ${tag.slice(0, 80)}`);
        assert.match(tail, /title=/, `${f}: ${tag.slice(0, 80)}`);
      } else {
        const at = src.indexOf(tag);
        assert.match(src.slice(at, at + 400), /title=/, `${f}: ${tag.slice(0, 80)}`);
      }
    }
  }
  assert.doesNotMatch(panel, /\p{Extended_Pictographic}/u, "แผงขวามี emoji");
});

test("CSS: แผงขวา 276px ตัวอักษร 13px หัวแชท 46px ปุ่มเสร็จแล้ว 36px ปุ่มไอคอนอย่างน้อย 32px พื้นแชทขาว", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.team-panel \{ width: 276px;[^}]*font-size: 13px;/);
  assert.match(css, /\.chat-head\.compact \{ min-height: 46px;/);
  assert.match(css, /\.btn\.done\.head-done \{[^}]*height: 36px;/);
  assert.match(css, /\.icon-btn \{[^}]*min-width: 32px; height: 32px;/);
  assert.match(css, /\.chat \{ flex: 1; min-width: 0; display: flex; flex-direction: column; background: #fff; \}/);
  assert.match(css, /@media \(max-width: 1279px\) \{\s*\.chat-area \{ flex-direction: column;/);
});
