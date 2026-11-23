// แจ้งเตือน push: ใครได้รับ · ไม่ส่งให้คนที่เปิดแชทอยู่ · ไม่มีข้อมูลคนไข้ · กันรัว · มอบหมาย · ปุ่มทดสอบ · ลบเครื่องที่ยกเลิก: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const rules = await import("../src/lib/push-rules.ts");
const { notifyAssigned, notifyNewMessage, setPresence, unreadChatCounts } = await import("../src/lib/push-store.ts");
const { aiTiming, storeIncoming } = await import("../src/lib/pipeline.ts");
const testRoute = await import("../src/app/api/push/test/route.ts");
const pushRoute = await import("../src/app/api/push/route.ts");
const presenceRoute = await import("../src/app/api/push/presence/route.ts");
const badgeRoute = await import("../src/app/api/push/badge/route.ts");

const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);
const CONV = "c0000000-0000-4000-8000-000000000001";
const STAFF = [
  { id: "admin", role: "admin", active: true, display_name: "A" },
  { id: "agent", role: "agent", active: true, display_name: "B", can_view_sensitive: false },
  { id: "agent2", role: "agent", active: true, display_name: "C", can_view_sensitive: false },
  { id: "pharm", role: "pharmacy", active: true, display_name: "P" },
  { id: "gone", role: "agent", active: false, display_name: "G" },
];

function setup() {
  reset();
  aiTiming.debounceMs = 0;
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }, { key: "business_hours", value: { tz: "Asia/Bangkok", days: {} } }],
    channels: [{ id: "ch", type: "line", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [{ id: "ct", channel_id: "ch", external_id: "U1", display_name: "คุณมาลี HN 1234567 0812345678", language: "th" }],
    conversations: [{ id: CONV, contact_id: "ct", channel_id: "ch", status: "open", assigned_to: null, sensitive: false, unread_count: 1, last_push_at: null, tags: [] }],
    staff: STAFF, staff_presence: [], user_preferences: [], bookings: [], tags: [], tag_rules: [], tag_events: [], reply_examples: [], knowledge_items: [], lab_items: [], lab_packages: [],
    push_subscriptions: ["admin", "agent", "agent2", "pharm", "gone"].map((id) => ({ endpoint: `https://p/${id}`, staff_id: id, p256dh: "k", auth: "a" })),
  });
  state.currentUser = { id: "admin", email: "a@test" };
}
beforeEach(setup);

const capture = () => {
  const sent = [];
  const send = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); };
  return { sent, send };
};
const json = (body) => new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json", "user-agent": "Test/1.0" }, body: JSON.stringify(body) });

test("ข้อความใหม่: ไม่มีผู้ดูแล → เจ้าหน้าที่แชททุกคน (ไม่รวมห้องยา/ปิดบัญชี) · ชื่อแชท + มีข้อความใหม่ + ช่องทาง ไม่มี HN/เบอร์", async () => {
  const { sent, send } = capture();
  assert.equal(await notifyNewMessage(CONV, NOW, send), 3);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), ["https://p/admin", "https://p/agent", "https://p/agent2"]);
  const p = sent[0];
  assert.equal(p.title, "คุณมาลี");
  assert.equal(p.body, "มีข้อความใหม่ · LINE");
  assert.equal(p.url, `/inbox?c=${CONV}`, "กดแล้วเปิดแชทนั้นตรงๆ");
  assert.equal(p.tag, `chat-${CONV}`);
  assert.equal(p.badge, 1, "ตัวเลขบนไอคอนแอป = แชทที่ยังไม่อ่าน");
  assert.doesNotMatch(JSON.stringify(sent), /1234567|0812345678|HN/);
});

test("ข้อความใหม่: มีผู้ดูแล → ผู้ดูแลคนเดียว · คนที่เปิดแชทนั้นอยู่ไม่ได้รับ (heartbeat หมดอายุแล้วได้รับ)", async () => {
  state.tables.conversations[0].assigned_to = "agent";
  let c = capture();
  await notifyNewMessage(CONV, NOW, c.send);
  assert.deepEqual(c.sent.map((s) => s.endpoint), ["https://p/agent"]);

  state.tables.conversations[0].assigned_to = null;
  state.tables.conversations[0].last_push_at = null;
  state.tables.staff_presence = [
    { staff_id: "agent", conversation_id: CONV, seen_at: new Date(NOW - 10_000).toISOString() },
    { staff_id: "agent2", conversation_id: CONV, seen_at: new Date(NOW - 120_000).toISOString() },
    { staff_id: "admin", conversation_id: "other", seen_at: new Date(NOW - 5_000).toISOString() },
  ];
  c = capture();
  await notifyNewMessage(CONV, NOW, c.send);
  assert.deepEqual(c.sent.map((s) => s.endpoint).sort(), ["https://p/admin", "https://p/agent2"]);
});

test("ข้อความใหม่: กันรัว 60 วิต่อแชท · แชทลับไม่ส่งชื่อ (ส่งข้อความกลางแยก) · ปิดแจ้งเตือนในตั้งค่าแล้วไม่ได้รับ", async () => {
  let c = capture();
  await notifyNewMessage(CONV, NOW, c.send);
  assert.ok(state.tables.conversations[0].last_push_at);
  assert.equal(await notifyNewMessage(CONV, NOW + 30_000, c.send), 0, "ลูกค้าพิมพ์หลายข้อความติดกัน");
  assert.equal(await notifyNewMessage(CONV, NOW + 61_000, c.send), 3);

  state.tables.conversations[0].last_push_at = null;
  state.tables.conversations[0].sensitive = true;
  c = capture();
  assert.equal(await notifyNewMessage(CONV, NOW, c.send), 0);

  state.tables.conversations[0].sensitive = false;
  state.tables.user_preferences = [{ user_id: "agent2", push_enabled: false }];
  c = capture();
  await notifyNewMessage(CONV, NOW + 200_000, c.send);
  assert.deepEqual(c.sent.map((s) => s.endpoint).sort(), ["https://p/admin", "https://p/agent"]);
});

test("ข้อความใหม่จาก webhook: แจ้งเมื่อรอตอบ ไม่แจ้งคำขอบคุณหลังปิดเคส", () => {
  const src = readFileSync("src/lib/pipeline.ts", "utf8");
  assert.match(src, /if \(!stayClosed && !closeNow && !ackOnly\) await notifyNewMessage\(conv\.id as string\);/);
  // ต้องอยู่หลังกฎแชทลับ (แชทที่เพิ่งติดลับไม่ส่งชื่อ)
  assert.ok(src.indexOf("await notifyNewMessage(") > src.indexOf("await applySensitiveRules(conv.id"));
});

test("storeIncoming จริง: ไม่มี VAPID key ก็ไม่พัง ข้อความเข้า inbox ตามปกติ", async () => {
  await storeIncoming({ channelType: "line", externalId: "U2", text: "สวัสดีค่ะ" });
  assert.ok(state.tables.messages.some((m) => m.body === "สวัสดีค่ะ"));
});

test("มอบหมาย: แจ้งคนที่ได้รับ ไม่แจ้งถ้ารับเอง · แชทลับไม่บอกชื่อ", async () => {
  let c = capture();
  assert.equal(await notifyAssigned(CONV, "agent", "admin", c.send), 1);
  assert.equal(c.sent[0].endpoint, "https://p/agent");
  assert.equal(c.sent[0].title, "คุณมาลี");
  assert.equal(c.sent[0].body, "มีแชทมอบหมายให้คุณ · LINE");
  assert.equal(c.sent[0].url, `/inbox?c=${CONV}`);
  assert.equal(await notifyAssigned(CONV, "agent", "agent", c.send), 0);
  assert.equal(await notifyAssigned(CONV, null, "admin", c.send), 0);
  state.tables.conversations[0].sensitive = true;
  c = capture();
  await notifyAssigned(CONV, "agent", "admin", c.send);
  assert.equal(c.sent[0].title, "DocDesk");
  const route = readFileSync("src/app/api/conversations/[id]/assign/route.ts", "utf8");
  assert.match(route, /await notifyAssigned\(id, to, user\.id\);/);
});

test("นัดที่ AI รับไว้: แจ้งทันทีหลังบันทึก (ใช้กฎเดียวกับ cron จึงไม่ซ้ำ)", () => {
  const src = readFileSync("src/lib/booking-store.ts", "utf8");
  assert.equal((src.match(/await pushPendingBookingsNow\(now\);/g) ?? []).length, 2, "ทั้งนัดใหม่และแก้นัดเดิม");
});

test("เครื่องที่ยกเลิกแล้ว (404/410) ถูกลบ · error อื่นเก็บไว้", async () => {
  const send = async (sub) => {
    if (sub.endpoint === "https://p/agent") throw Object.assign(new Error("gone"), { statusCode: 410 });
    if (sub.endpoint === "https://p/agent2") throw Object.assign(new Error("busy"), { statusCode: 503 });
  };
  assert.equal(await notifyNewMessage(CONV, NOW, send), 1);
  assert.deepEqual(state.tables.push_subscriptions.map((s) => s.endpoint).sort(), ["https://p/admin", "https://p/agent2", "https://p/gone", "https://p/pharm"]);
});

test("API: สมัครเครื่องเก็บ user_agent หลายเครื่องต่อคน · ทดสอบส่งเฉพาะเครื่องตัวเอง · presence · badge", async () => {
  state.currentUser = { id: "agent", email: "b@test" };
  assert.equal((await pushRoute.POST(json({ endpoint: "https://p/agent-phone", keys: { p256dh: "k", auth: "a" } }))).status, 200);
  const mine = state.tables.push_subscriptions.filter((s) => s.staff_id === "agent");
  assert.equal(mine.length, 2, "คอม + มือถือ");
  assert.equal(mine.find((s) => s.endpoint === "https://p/agent-phone").user_agent, "Test/1.0");
  assert.equal((await pushRoute.POST(json({ endpoint: "http://insecure", keys: { p256dh: "k", auth: "a" } }))).status, 400);

  assert.equal((await testRoute.POST(json({ endpoint: "https://p/admin" }))).status, 404, "เครื่องของคนอื่นทดสอบไม่ได้");

  assert.equal((await presenceRoute.POST(json({ conversationId: CONV }))).status, 200);
  assert.equal(state.tables.staff_presence.find((p) => p.staff_id === "agent").conversation_id, CONV);
  await presenceRoute.POST(json({ conversationId: null }));
  assert.equal(state.tables.staff_presence.find((p) => p.staff_id === "agent").conversation_id, null);
  await setPresence("agent", "not-a-uuid");

  state.tables.conversations.push({ id: "c2", contact_id: "ct", channel_id: "ch", status: "open", sensitive: true, unread_count: 2 });
  state.tables.conversations.push({ id: "c3", contact_id: "ct", channel_id: "ch", status: "closed", sensitive: false, unread_count: 2 });
  assert.deepEqual(await unreadChatCounts(), { all: 2, nonSensitive: 1 });
  assert.deepEqual(await (await badgeRoute.GET()).json(), { count: 1 }, "ไม่มีสิทธิ์แชทลับไม่นับแชทลับ");

  state.currentUser = null;
  assert.equal((await pushRoute.POST(json({}))).status, 401);
  assert.equal((await testRoute.POST(json({}))).status, 401);
});

test("กฎ: ชื่อแชทตัด HN/เบอร์ · สถานะปุ่มแจ้งเตือน · วิธีเปิดหลังปฏิเสธตามเครื่อง", () => {
  assert.equal(rules.safeChatName("Somchai 089-123-4567"), "Somchai");
  assert.equal(rules.safeChatName("HN: 12345"), "ลูกค้า");
  assert.equal(rules.safeChatName(null), "ลูกค้า");
  assert.equal(rules.safeChatName("ก".repeat(60)).length, 40);
  const base = { ready: true, isIOS: false, isInstalled: false, supported: true, permission: "default", subscribed: false, enabled: true };
  assert.equal(rules.pushUiState({ ...base, ready: false }), "loading");
  assert.equal(rules.pushUiState({ ...base, isIOS: true }), "ios-install-first", "iPhone ยังไม่ติดตั้ง");
  assert.equal(rules.pushUiState({ ...base, isIOS: true, isInstalled: true }), "off");
  assert.equal(rules.pushUiState({ ...base, supported: false }), "unsupported");
  assert.equal(rules.pushUiState({ ...base, permission: "denied" }), "denied");
  assert.equal(rules.pushUiState({ ...base, permission: "granted", subscribed: true }), "on");
  assert.equal(rules.pushUiState({ ...base, permission: "granted", subscribed: true, enabled: false }), "off");
  assert.match(rules.deniedHelp({ isIOS: true, isAndroid: false }), /ตั้งค่า.*การแจ้งเตือน > DocDesk/);
  assert.match(rules.deniedHelp({ isIOS: false, isAndroid: true }), /การแจ้งเตือน/);
});

test("หน้าจอ: ขอสิทธิ์จากการกดปุ่มเท่านั้น · requestPermission ก่อน await อื่น · subscribe ใหม่ตอนเปิดแอปถ้าหาย · SW แสดงแจ้งเตือนทุกครั้ง + badge", () => {
  const ui = readFileSync("src/app/(staff)/push-control.tsx", "utf8");
  // requestPermission อยู่บรรทัดแรกของฟังก์ชันที่เรียกจากปุ่มเท่านั้น
  assert.match(ui, /async function subscribeFromClick\(\)[^\n]*\{\n  const permission = await Notification\.requestPermission\(\);/);
  assert.equal((ui.match(/requestPermission\(/g) ?? []).length, 1);
  assert.doesNotMatch(readFileSync("src/app/(staff)/push-toggle.tsx", "utf8"), /requestPermission/);
  assert.match(ui, /export function PushKeeper\(\)/);
  assert.match(ui, /Notification\.permission !== "granted"\) return;/, "เปิดแอป: สมัครใหม่เฉพาะคนที่ให้สิทธิ์แล้ว ไม่ถาม");
  assert.match(ui, /แจ้งเตือนเปิดอยู่ ✓/);
  assert.match(ui, /ทดสอบแจ้งเตือน/);
  assert.match(ui, /ต้องติดตั้งลงหน้าจอก่อน/);
  assert.match(ui, /push\.permission === "default"/, "แบนเนอร์ไม่กวนคนที่ปิดเองหรือเคยปฏิเสธ");
  const sw = readFileSync("src/app/sw.ts", "utf8");
  assert.match(sw, /self\.registration\.showNotification\(/);
  assert.match(sw, /setAppBadge/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  const inbox = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(inbox, /"\/api\/push\/presence"/);
  const sql = readFileSync("supabase/migrations/065_push_notifications.sql", "utf8");
  assert.match(sql, /add column if not exists user_agent text/);
  assert.match(sql, /create table if not exists staff_presence/);
});
