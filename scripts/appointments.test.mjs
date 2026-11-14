// ระบบนัดครั้งต่อไป: npm test
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

process.env.LINE_CHANNEL_SECRET = "line-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
process.env.META_APP_SECRET = "meta-secret";
process.env.META_PAGE_ACCESS_TOKEN = "page-token";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://sb.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-key";

const { calls, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const rules = await import("../src/lib/appointment-rules.ts");
const store = await import("../src/lib/appointment-store.ts");
const { parseMetaWebhook, parseMetaPostbacks } = await import("../src/lib/channels/meta.ts");
const { tabsOf } = await import("../src/lib/case-flow.ts");
const lineWebhook = await import("../src/app/api/webhooks/line/route.ts");
const metaWebhook = await import("../src/app/api/webhooks/meta/route.ts");
const appointmentsRoute = await import("../src/app/api/appointments/route.ts");
const patientLinkRoute = await import("../src/app/api/conversations/[id]/patient-link/route.ts");
const contactRoute = await import("../src/app/api/conversations/[id]/contact/route.ts");
const names = await import("../src/lib/patient-name.ts");
const { storeIncoming } = await import("../src/lib/pipeline.ts");

const HOUR = 3_600_000;
const realFetch = globalThis.fetch;
let outbound;
// คนไข้ใน iService จำลอง: HN → { name, phone }
let his;

const LINE_USER = "U1234567890";
const PURPOSE_BLOOD = "11111111-2222-4333-8444-555555555551";
const PURPOSE_LAB = "11111111-2222-4333-8444-555555555552";
const PURPOSE_OFF = "11111111-2222-4333-8444-555555555553";
const FB_USER = "fb-psid-1";
const IG_USER = "ig-sid-1";

beforeEach(() => {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "auto" }, { key: "clinic_profile", value: { name: "คลินิกทดสอบ" } }],
    channels: [
      { id: "line", type: "line", name: "LINE", ai_mode: null, enabled: true, created_at: nextTime() },
      { id: "fb", type: "facebook", name: "Facebook", ai_mode: null, enabled: true, created_at: nextTime() },
      { id: "ig", type: "instagram", name: "Instagram", ai_mode: null, enabled: true, created_at: nextTime() },
      { id: "web", type: "web", name: "เว็บ", ai_mode: null, enabled: true, created_at: nextTime() },
    ],
    contacts: [
      { id: "c-line", channel_id: "line", external_id: LINE_USER, display_name: "สมชาย", language: "th" },
      { id: "c-fb", channel_id: "fb", external_id: FB_USER, display_name: "John", language: "en" },
      { id: "c-ig", channel_id: "ig", external_id: IG_USER, display_name: "IG user", language: "th" },
    ],
    conversations: [
      { id: "conv-line", contact_id: "c-line", channel_id: "line", status: "closed", tags: [], unread_count: 0, open_tasks: 0, sensitive: false, archived: false },
      { id: "conv-fb", contact_id: "c-fb", channel_id: "fb", status: "open", tags: [], unread_count: 0, open_tasks: 0, sensitive: false, archived: false },
      { id: "conv-ig", contact_id: "c-ig", channel_id: "ig", status: "open", tags: [], unread_count: 0, open_tasks: 0, sensitive: false, archived: false },
    ],
    appointments: [], appointment_events: [], patient_links: [], clinic_closures: [],
    clinic_hours: [
      ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, slot_id: "morning", label: "ช่วงเช้า", start_time: "08:00:00", end_time: "12:00:00", sort_order: 10 })),
      ...[1, 2, 3, 4, 5].map((d) => ({ weekday: d, slot_id: "afternoon", label: "ช่วงบ่าย", start_time: "13:00:00", end_time: "18:00:00", sort_order: 20 })),
    ],
    appointment_purposes: [
      { id: PURPOSE_BLOOD, name: "เจาะเลือด", default_days: null, reminder_extra_text: "งดน้ำงดอาหาร 8–12 ชม. (ดื่มน้ำเปล่าได้)", sort_order: 20, active: true },
      { id: PURPOSE_LAB, name: "ฟังผลแล็บ", default_days: 7, reminder_extra_text: null, sort_order: 10, active: true },
      { id: PURPOSE_OFF, name: "เลิกใช้", default_days: null, reminder_extra_text: null, sort_order: 90, active: false },
    ], chat_tasks: [], chat_notes: [], bookings: [], push_subscriptions: [],
    tags: [], tag_rules: [], tag_events: [], reply_examples: [], staff: [
      { id: "nurse", role: "pharmacy", active: true, display_name: "พยาบาล", must_change_password: false },
      { id: "agent", role: "agent", active: true, display_name: "เอ", must_change_password: false },
      { id: "adm", role: "admin", active: true, display_name: "แอดมิน", can_view_sensitive: true, must_change_password: false },
    ],
  });
  state.currentUser = { id: "nurse", email: "n@test" };
  outbound = [];
  his = {};
  globalThis.fetch = async (url, init) => {
    outbound.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url) === "https://sb.test/functions/v1/iservice") {
      if (init.headers.Authorization !== "Bearer svc-key") return new Response("{}", { status: 403 });
      const hn = JSON.parse(init.body).hn;
      return Response.json({ patient: his[hn] ? { hn, ...his[hn] } : null });
    }
    return new Response(JSON.stringify({ message_id: `mid_${outbound.length}` }), { status: 200 });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

// วันนัดต้องเป็นอนาคตเทียบกับนาฬิกาจริง เพราะ store ใช้ Date.now()
const today = rules.bangkokToday();
const inDays = (n) => rules.addDays(today, n);

function addAppointment(extra = {}) {
  const row = {
    id: crypto.randomUUID(), hn: "HN001", patient_name: "สมชาย ใจดี", phone: "0812345678", conversation_id: "conv-line",
    appoint_date: inDays(7), time_mode: "exact", slot_id: null, time_start: "10:00", time_end: null,
    purpose_id: null, purpose_text: "ติดตามความดัน", instructions: null, provider: "นพ.ทดสอบ", note: null,
    status: "scheduled", link_code: "ABC234", confirm_sent_at: null, reminder_sent_at: null, reminder_attempted_at: null,
    last_send_error: null, called_at: null, called_by: null, created_at: nextTime(), ...extra,
  };
  state.tables.appointments.push(row);
  return row;
}
const appt = (id) => state.tables.appointments.find((a) => a.id === id);
const conv = (id) => state.tables.conversations.find((c) => c.id === id);
const messagesOf = (id) => state.tables.messages.filter((m) => m.conversation_id === id);
const inboundLast = (conversationId, at) => state.tables.messages.push({
  id: `in-${state.tables.messages.length}`, conversation_id: conversationId, direction: "in", sender_type: "customer",
  body: "สวัสดี", imported: false, created_at: new Date(at).toISOString(),
});

function lineRequest(events) {
  const raw = JSON.stringify({ events });
  const sig = crypto.createHmac("sha256", "line-secret").update(raw).digest("base64");
  return new Request("https://app.test/api/webhooks/line", { method: "POST", headers: { "x-line-signature": sig }, body: raw });
}
function metaRequest(body) {
  const raw = JSON.stringify(body);
  const sig = `sha256=${crypto.createHmac("sha256", "meta-secret").update(raw).digest("hex")}`;
  return new Request("https://app.test/api/webhooks/meta", { method: "POST", headers: { "x-hub-signature-256": sig }, body: raw });
}
const linePostback = (data, id = "ev-1") => ({
  type: "postback", webhookEventId: id, replyToken: "rt-1", source: { type: "user", userId: LINE_USER }, postback: { data },
});
const lineText = (text, id = "msg-1") => ({
  type: "message", replyToken: "rt-2", source: { type: "user", userId: LINE_USER }, message: { id, type: "text", text },
});
const linePosts = () => outbound.filter((o) => o.url.includes("api.line.me/v2/bot/message/"));

// ---------------------------------------------------------------------------
// กติกา
// ---------------------------------------------------------------------------
test("รหัสจากใบนัด: รูปแบบที่คนไข้ส่งมา", () => {
  assert.equal(rules.parseLinkCode("ยืนยันนัด #abc234"), "ABC234");
  assert.equal(rules.parseLinkCode("ยืนยันนัด#ABC234"), "ABC234");
  assert.equal(rules.parseLinkCode("text=ยืนยันนัด #ABC234"), "ABC234");
  assert.equal(rules.parseLinkCode("Confirm appointment #XYZ789"), "XYZ789");
  assert.equal(rules.parseLinkCode("#QWE456"), "QWE456");
  assert.equal(rules.parseLinkCode("ยืนยันนัด #ABC2345"), null, "ยาวเกิน 6 ตัว");
  assert.equal(rules.parseLinkCode("นัดวันไหนดีคะ ABC234"), null);
  assert.equal(rules.parseLinkCode("โทร 0812345678"), null);
});

test("รหัสสุ่ม 6 ตัว ไม่มีตัวที่อ่านสับสน", () => {
  for (let i = 0; i < 200; i++) assert.match(rules.generateLinkCode(), /^[A-HJ-NP-Z2-9]{6}$/);
});

test("postback ของระบบนัด", () => {
  const id = "3f2b6a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.deepEqual(rules.parseAppointmentPostback(rules.postbackData("confirm", id)), { action: "confirm", appointmentId: id });
  assert.deepEqual(rules.parseAppointmentPostback(`appt:reschedule:${id}`), { action: "reschedule", appointmentId: id });
  assert.equal(rules.parseAppointmentPostback("appt:delete:" + id), null);
  assert.equal(rules.parseAppointmentPostback("appt:confirm:../../x"), null);
  assert.equal(rules.parseAppointmentPostback(null), null);
});

test("QR บนใบนัดเปิด LINE OA พร้อมข้อความรหัส", () => {
  const url = rules.lineOaMessageUrl("@p49clinic", "ABC234");
  assert.equal(url, `https://line.me/R/oaMessage/%40p49clinic/?${encodeURIComponent("ยืนยันนัด #ABC234")}`);
  assert.equal(rules.lineOaMessageUrl("p49clinic", "ABC234"), url, "เติม @ ให้");
  assert.equal(rules.parseLinkCode(decodeURIComponent(url.split("?")[1])), "ABC234");
});

// ---------------------------------------------------------------------------
// เลือกช่องทาง 24 ชม.
// ---------------------------------------------------------------------------
test("เลือกช่องทาง: LINE ส่งได้เสมอ Facebook/Instagram เฉพาะ 24 ชม. ห้าม message tag", () => {
  const now = Date.parse("2030-01-02T03:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.deepEqual(rules.chooseDelivery({ channelType: "line", lastInboundAt: null, now }), { ok: true, via: "line" });
  assert.deepEqual(rules.chooseDelivery({ channelType: "line", lastInboundAt: ago(30 * 24 * HOUR), now }), { ok: true, via: "line" });
  assert.deepEqual(rules.chooseDelivery({ channelType: "facebook", lastInboundAt: ago(HOUR), now }), { ok: true, via: "facebook" });
  assert.deepEqual(rules.chooseDelivery({ channelType: "instagram", lastInboundAt: ago(24 * HOUR), now }), { ok: true, via: "instagram" }, "ครบ 24 ชม. พอดียังส่งได้");
  assert.deepEqual(rules.chooseDelivery({ channelType: "facebook", lastInboundAt: ago(24 * HOUR + 1000), now }), { ok: false, reason: "outside_24h" });
  // เกิน 24 ชม. แต่ไม่ถึง 7 วัน: ข้อความคนส่งใช้ HUMAN_AGENT ได้ แต่ข้อความระบบห้าม
  assert.deepEqual(rules.chooseDelivery({ channelType: "facebook", lastInboundAt: ago(3 * 24 * HOUR), now }), { ok: false, reason: "outside_24h" });
  assert.deepEqual(rules.chooseDelivery({ channelType: "instagram", lastInboundAt: null, now }), { ok: false, reason: "outside_24h" });
  assert.deepEqual(rules.chooseDelivery({ channelType: "facebook", lastInboundAt: ago(-HOUR), now }), { ok: false, reason: "outside_24h" }, "เวลาในอนาคตไม่เชื่อ");
  assert.deepEqual(rules.chooseDelivery({ channelType: "web", lastInboundAt: ago(HOUR), now }), { ok: false, reason: "web" });
  assert.deepEqual(rules.chooseDelivery({ channelType: null, lastInboundAt: null, now }), { ok: false, reason: "no_chat" });
  assert.deepEqual(rules.chooseDelivery({ channelType: "line", lastInboundAt: null, archived: true, now }), { ok: false, reason: "archived" });
  assert.match(rules.DELIVERY_FAILURE_TEXT.outside_24h, /ส่งไม่ได้-ต้องโทร/);
});

test("ลงนัดแชท Facebook นอก 24 ชม.: ไม่ยิง Graph API บันทึกว่าส่งไม่ได้-ต้องโทร", async () => {
  inboundLast("conv-fb", Date.now() - 30 * HOUR);
  const { appointment, delivery } = await store.createAppointment({ patient_name: "John", appoint_date: inDays(3), time_mode: "exact", time_start: "14:00", conversation_id: "conv-fb" }, "agent");
  assert.equal(delivery.sent, false);
  assert.equal(outbound.filter((o) => o.url.includes("graph.facebook.com")).length, 0);
  assert.match(appt(appointment.id).last_send_error, /ส่งไม่ได้-ต้องโทร/);
  assert.equal(rules.deliveryState(appt(appointment.id)), "failed");
  assert.equal(rules.callQueue(state.tables.appointments).mustCall, 0, "นัดอีก 3 วัน ยังไม่เข้าคิวโทร");
});

test("ลงนัดแชท Facebook ภายใน 24 ชม.: button template แบบ RESPONSE ไม่มี tag ภาษาอังกฤษตามแชท", async () => {
  inboundLast("conv-fb", Date.now() - HOUR);
  const { appointment, delivery } = await store.createAppointment({ patient_name: "John", appoint_date: inDays(3), time_mode: "exact", time_start: "14:00", conversation_id: "conv-fb", purpose_text: "HIV test" }, "agent");
  assert.deepEqual(delivery, { sent: true, via: "facebook" });
  const sent = outbound.find((o) => o.url.includes("/me/messages"));
  assert.equal(sent.body.messaging_type, "RESPONSE");
  assert.equal(sent.body.tag, undefined);
  const payload = sent.body.message.attachment.payload;
  assert.equal(payload.template_type, "button");
  assert.match(payload.text, /Dear John/);
  assert.doesNotMatch(payload.text, /HIV/, "ค่าเริ่มต้นไม่ใส่เหตุผลนัด");
  assert.deepEqual(payload.buttons.map((b) => b.payload), [`appt:confirm:${appointment.id}`, `appt:reschedule:${appointment.id}`]);
  const msg = messagesOf("conv-fb").find((m) => m.direction === "out");
  assert.equal(msg.sender_type, "system");
  assert.equal(msg.imported_sender_name, "ระบบนัด");
  assert.equal(msg.external_id, "mid_1", "เก็บ mid กัน echo ซ้ำ");
  assert.ok(appt(appointment.id).confirm_sent_at);
});

test("Instagram ใช้ quick reply และเหตุผลนัดไม่ส่งในแชทลับแม้เปิดตั้งค่า", async () => {
  state.tables.settings.push({ key: "appointment_settings", value: { send_purpose_in_message: true } });
  inboundLast("conv-ig", Date.now() - HOUR);
  conv("conv-ig").sensitive = true;
  await store.createAppointment({ patient_name: "ไอจี", appoint_date: inDays(2), time_mode: "exact", time_start: "09:00", conversation_id: "conv-ig", purpose_text: "ผลเลือด" }, "agent");
  const sent = outbound.find((o) => o.url.includes("/me/messages")).body.message;
  assert.equal(sent.quick_replies.length, 2);
  assert.doesNotMatch(sent.text, /ผลเลือด/);
  conv("conv-ig").sensitive = false;
  outbound = [];
  await store.createAppointment({ patient_name: "ไอจี", appoint_date: inDays(2), time_mode: "exact", time_start: "09:30", conversation_id: "conv-ig", purpose_text: "ผลเลือด" }, "agent");
  assert.match(outbound.find((o) => o.url.includes("/me/messages")).body.message.text, /เรื่อง: ผลเลือด/);
});

test("ลงนัดจากหน้านัดหมาย: HN ผูกแชท LINE แล้วส่ง Flex พร้อมปุ่ม ไม่ผูกแล้วไม่ส่ง", async () => {
  state.tables.patient_links.push({ conversation_id: "conv-line", hn: "HN777", linked_at: nextTime() });
  const res = await appointmentsRoute.POST(new Request("https://app.test/api/appointments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hn: "HN777", patient_name: "สมชาย", appoint_date: inDays(14), time_mode: "exact", time_start: "13:00", provider: "นพ.ก" }),
  }));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.delivery, { sent: true, via: "line" });
  assert.equal(j.appointment.conversation_id, "conv-line");
  const push = linePosts()[0].body;
  assert.equal(push.to, LINE_USER);
  const flex = push.messages[0];
  assert.equal(flex.type, "flex");
  assert.match(JSON.stringify(flex), new RegExp(String(Number(inDays(14).slice(0, 4)) + 543)), "ปี พ.ศ.");
  assert.deepEqual(flex.contents.footer.contents.map((b) => b.action.data), [`appt:confirm:${j.appointment.id}`, `appt:reschedule:${j.appointment.id}`]);
  assert.equal(conv("conv-line").status, "closed", "แชทที่เสร็จแล้วไม่เด้งกลับ");
  assert.deepEqual(tabsOf(conv("conv-line")), ["closed"]);

  outbound = [];
  const res2 = await appointmentsRoute.POST(new Request("https://app.test/api/appointments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hn: "HN999", patient_name: "คนใหม่", appoint_date: inDays(14), time_mode: "exact", time_start: "13:00" }),
  }));
  const j2 = await res2.json();
  assert.equal(j2.delivery.sent, false);
  assert.match(j2.delivery.error, /สแกน QR/);
  assert.equal(outbound.length, 0);
});

test("ห้องยาทำนัดจากแชทไม่ได้", async () => {
  const res = await appointmentsRoute.POST(new Request("https://app.test/api/appointments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_name: "x", appoint_date: inDays(1), time_mode: "exact", time_start: "10:00", conversation_id: "conv-line" }),
  }));
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// webhook: postback
// ---------------------------------------------------------------------------
test("LINE กดยืนยัน: confirmed ตอบขอบคุณด้วย replyToken แชทคงสถานะเดิม AI ไม่ตอบ", async () => {
  const a = addAppointment();
  const res = await lineWebhook.POST(lineRequest([linePostback(`appt:confirm:${a.id}`)]));
  assert.equal(res.status, 200);
  assert.equal(appt(a.id).status, "confirmed");
  const reply = linePosts().find((o) => o.url.endsWith("/reply"));
  assert.equal(reply.body.replyToken, "rt-1");
  assert.match(reply.body.messages[0].text, /ขอบคุณที่ยืนยันนัด/);
  assert.equal(conv("conv-line").status, "closed");
  assert.deepEqual(tabsOf(conv("conv-line")), ["closed"]);
  assert.ok(messagesOf("conv-line").every((m) => m.sender_type === "system"), "บันทึกเป็นข้อความระบบ ไม่นับในคิว");
  assert.equal(calls.chat, 0, "ไม่เรียก AI");
  assert.ok(state.tables.appointment_events.some((e) => e.appointment_id === a.id && e.kind === "confirmed" && e.actor === "customer" && e.channel === "line"));

  // LINE ส่ง webhook เดิมซ้ำ: ไม่ตอบซ้ำ
  outbound = [];
  await lineWebhook.POST(lineRequest([linePostback(`appt:confirm:${a.id}`)]));
  assert.equal(linePosts().length, 0);
});

test("LINE กดขอเลื่อน: ตอบว่าจะติดต่อกลับ ย้ายเข้ารอตอบ สร้างงานเลื่อนนัด", async () => {
  const a = addAppointment({ called_at: nextTime(), called_by: "agent" });
  await lineWebhook.POST(lineRequest([linePostback(`appt:reschedule:${a.id}`, "ev-2")]));
  assert.equal(appt(a.id).status, "reschedule_requested");
  assert.equal(appt(a.id).called_at, null, "ต้องโทรใหม่");
  assert.match(linePosts().find((o) => o.url.endsWith("/reply")).body.messages[0].text, /เจ้าหน้าที่จะติดต่อกลับเพื่อนัดวันใหม่/);
  const task = state.tables.chat_tasks.find((t) => t.conversation_id === "conv-line");
  assert.match(task.text, /^เลื่อนนัด/);
  assert.ok(!task.done);
  assert.equal(conv("conv-line").status, "open");
  assert.equal(conv("conv-line").open_tasks, 1);
  assert.deepEqual(tabsOf(conv("conv-line")), ["open", "waiting"]);
  assert.equal(rules.callQueue(state.tables.appointments).reschedule, 1);
  assert.equal(calls.chat, 0);
});

test("postback ปลอมหรือของแชทอื่น: ไม่เปลี่ยนนัด", async () => {
  const other = addAppointment({ conversation_id: "conv-fb" });
  await lineWebhook.POST(lineRequest([linePostback(`appt:confirm:${other.id}`, "ev-3")]));
  assert.equal(appt(other.id).status, "scheduled");
  const cancelled = addAppointment({ status: "cancelled", link_code: "ZZZ999" });
  await lineWebhook.POST(lineRequest([linePostback(`appt:confirm:${cancelled.id}`, "ev-4")]));
  assert.equal(appt(cancelled.id).status, "cancelled");
  assert.match(linePosts().at(-1).body.messages[0].text, /ถูกยกเลิกหรือผ่านไปแล้ว/);
});

test("Facebook postback และ Instagram quick reply: ไม่เข้า AI และเปลี่ยนสถานะนัด", async () => {
  const fbAppt = addAppointment({ conversation_id: "conv-fb", link_code: "FBB222" });
  const igAppt = addAppointment({ conversation_id: "conv-ig", link_code: "IGG333" });
  const fbBody = { object: "page", entry: [{ id: "PAGE", messaging: [{ sender: { id: FB_USER }, recipient: { id: "PAGE" }, timestamp: 1, postback: { mid: "pb-1", title: "Confirm", payload: `appt:confirm:${fbAppt.id}` } }] }] };
  const igBody = { object: "instagram", entry: [{ id: "IGACC", messaging: [{ sender: { id: IG_USER }, recipient: { id: "IGACC" }, timestamp: 2, message: { mid: "ig-qr-1", text: "ขอเลื่อนนัด", quick_reply: { payload: `appt:reschedule:${igAppt.id}` } } }] }] };
  assert.equal(parseMetaWebhook(igBody).length, 0, "quick reply ของระบบนัดไม่ใช่ข้อความเข้า");
  assert.equal(parseMetaPostbacks(igBody).length, 1);

  await metaWebhook.POST(metaRequest(fbBody));
  await metaWebhook.POST(metaRequest(igBody));
  assert.equal(appt(fbAppt.id).status, "confirmed");
  assert.equal(appt(igAppt.id).status, "reschedule_requested");
  const replies = outbound.filter((o) => o.url.includes("/me/messages")).map((o) => o.body);
  assert.match(replies[0].message.text, /Thank you for confirming/, "แชทภาษาอังกฤษตอบอังกฤษ");
  assert.ok(replies.every((r) => r.messaging_type === "RESPONSE" && !r.tag));
  assert.equal(calls.chat, 0);
});

// ---------------------------------------------------------------------------
// webhook: รหัสจากใบนัด
// ---------------------------------------------------------------------------
test("ส่ง ยืนยันนัด #รหัส: ผูกแชทกับนัดและ HN แล้วส่ง Flex รายละเอียดนัด AI ไม่ตอบทับ", async () => {
  const a = addAppointment({ conversation_id: null, hn: "HN555" });
  const later = addAppointment({ conversation_id: null, hn: "HN555", link_code: "LTR888", appoint_date: inDays(60) });
  // แชทใหม่ที่ไม่เคยทัก: สร้างแชทให้
  const res = await lineWebhook.POST(lineRequest([{ ...lineText("ยืนยันนัด #abc234"), source: { type: "user", userId: "Unew" } }]));
  assert.equal(res.status, 200);
  const newConv = state.tables.conversations.find((c) => state.tables.contacts.find((x) => x.id === c.contact_id)?.external_id === "Unew");
  assert.ok(newConv);
  assert.equal(appt(a.id).conversation_id, newConv.id);
  assert.equal(appt(later.id).conversation_id, newConv.id, "นัดอื่นของ HN เดียวกันได้เตือนด้วย");
  assert.deepEqual(state.tables.patient_links.map((l) => [l.conversation_id, l.hn, l.source]), [[newConv.id, "HN555", "link_code"]]);
  const reply = linePosts().find((o) => o.url.endsWith("/reply"));
  assert.equal(reply.body.replyToken, "rt-2", "ใช้ replyToken ไม่กินโควตา");
  assert.equal(reply.body.messages[0].type, "flex");
  assert.match(reply.body.messages[0].altText, /รับข้อความเตือนนัด/);
  assert.ok(appt(a.id).confirm_sent_at);
  assert.equal(calls.chat, 0, "ไม่เรียก AI");
  assert.ok(messagesOf(newConv.id).every((m) => m.sender_type === "system"));
  assert.notEqual(newConv.last_direction, "in", "ไม่เข้ารอตอบ (ข้อความระบบนัด = คลินิกตอบแล้ว)");
});

test("รหัสผิดหรือนัดยกเลิกแล้ว: ตอบสั้นๆ ไม่ผูก", async () => {
  await lineWebhook.POST(lineRequest([lineText("ยืนยันนัด #NOPE22", "m-a")]));
  assert.match(linePosts().at(-1).body.messages[0].text, /ไม่พบรหัสนัด/);
  const a = addAppointment({ conversation_id: null, status: "cancelled", link_code: "CAN777" });
  await lineWebhook.POST(lineRequest([lineText("ยืนยันนัด #CAN777", "m-b")]));
  assert.equal(appt(a.id).conversation_id, null);
  assert.equal(calls.chat, 0);
});

test("ข้อความทั่วไปยังเข้า pipeline เดิม", async () => {
  await lineWebhook.POST(lineRequest([lineText("สวัสดีค่ะ มีนัดพรุ่งนี้", "m-c")]));
  const m = messagesOf("conv-line").at(-1);
  assert.equal(m.sender_type, "customer");
  assert.equal(conv("conv-line").status, "open");
});

// ---------------------------------------------------------------------------
// เตือนก่อนวันนัด
// ---------------------------------------------------------------------------
test("เวลาเตือน: วันก่อนนัดหลัง reminder_time เท่านั้น", () => {
  const settings = { reminder_time: "10:00" };
  const at = (iso) => Date.parse(iso); // เวลาไทย = UTC+7
  const base = { status: "scheduled", appoint_date: "2030-01-03", reminder_sent_at: null, reminder_attempted_at: null, confirm_sent_at: "2029-12-20T03:00:00Z" };
  assert.equal(rules.reminderDecision(base, settings, at("2030-01-02T02:59:00Z")), null, "09:59");
  assert.equal(rules.reminderDecision(base, settings, at("2030-01-02T03:00:00Z")), "send", "10:00");
  assert.equal(rules.reminderDecision(base, settings, at("2030-01-02T17:30:00Z")), null, "00:30 กลายเป็นวันนัดแล้ว");
  assert.equal(rules.reminderDecision({ ...base, appoint_date: "2030-01-04" }, settings, at("2030-01-02T05:00:00Z")), null);
  assert.equal(rules.reminderDecision({ ...base, reminder_sent_at: "x" }, settings, at("2030-01-02T05:00:00Z")), null);
  assert.equal(rules.reminderDecision({ ...base, reminder_attempted_at: "x" }, settings, at("2030-01-02T05:00:00Z")), null);
  assert.equal(rules.reminderDecision({ ...base, status: "confirmed" }, settings, at("2030-01-02T05:00:00Z")), "send");
  assert.equal(rules.reminderDecision({ ...base, status: "reschedule_requested" }, settings, at("2030-01-02T05:00:00Z")), null);
  assert.equal(rules.reminderDecision({ ...base, confirm_sent_at: "2030-01-02T01:00:00Z" }, settings, at("2030-01-02T05:00:00Z")), "skip", "เพิ่งได้ข้อความนัดเช้านี้");
});

test("cron เตือน: ส่งครั้งเดียวแม้รันซ้ำ นอก 24 ชม. บันทึกว่าต้องโทร", async () => {
  const tomorrow = inDays(1);
  const now = Date.parse(`${today}T16:59:00+07:00`);
  const line = addAppointment({ appoint_date: tomorrow, confirm_sent_at: new Date(now - 5 * 24 * HOUR).toISOString() });
  inboundLast("conv-fb", now - 48 * HOUR);
  const fb = addAppointment({ appoint_date: tomorrow, conversation_id: "conv-fb", link_code: "FBX123" });
  const noChat = addAppointment({ appoint_date: tomorrow, conversation_id: null, link_code: "NOC123" });

  const r1 = await store.runAppointmentReminders(now);
  assert.deepEqual(r1, { sent: 1, failed: 2, skipped: 0 });
  assert.ok(appt(line.id).reminder_sent_at);
  assert.equal(linePosts().length, 1);
  assert.match(linePosts()[0].body.messages[0].altText, /เตือนนัดพรุ่งนี้/);
  assert.match(appt(fb.id).last_send_error, /ส่งไม่ได้-ต้องโทร/);
  assert.equal(rules.deliveryState(appt(noChat.id)), "no_chat");
  assert.equal(rules.callQueue(state.tables.appointments, now).mustCall, 2);

  outbound = [];
  const r2 = await store.runAppointmentReminders(now + 15 * 60_000);
  assert.deepEqual(r2, { sent: 0, failed: 0, skipped: 0 });
  assert.equal(outbound.length, 0);
});

test("แก้วันนัดส่งข้อความนัดใหม่และเริ่มรอบเตือนใหม่ ยกเลิกส่งแจ้งยกเลิกไม่มีปุ่ม", async () => {
  const a = addAppointment({ reminder_sent_at: nextTime(), reminder_attempted_at: nextTime(), status: "confirmed" });
  const { delivery } = await store.updateAppointment(a.id, { appoint_date: inDays(20) }, "agent");
  assert.equal(delivery.sent, true);
  assert.equal(appt(a.id).status, "scheduled");
  assert.equal(appt(a.id).reminder_sent_at, null);
  assert.match(linePosts()[0].body.messages[0].altText, /เปลี่ยนวันนัดใหม่/);

  outbound = [];
  const none = await store.updateAppointment(a.id, { note: "งดอาหาร" }, "agent");
  assert.equal(none.delivery, null, "แก้หมายเหตุไม่ส่งข้อความ");
  assert.equal(outbound.length, 0);

  await store.cancelAppointment(a.id, "agent", { code: "patient" });
  assert.equal(appt(a.id).status, "cancelled");
  const flex = linePosts()[0].body.messages[0];
  assert.match(flex.altText, /ยกเลิกนัด/);
  assert.equal(flex.contents.footer, undefined);
});

test("แปลงนัดที่ AI รับไว้เป็นนัดจริง: booking เป็น recorded ป้ายลงนัดก่อนหาย", async () => {
  state.tables.bookings.push({ id: "bk1", conversation_id: "conv-line", service: "ตรวจเลือด", date: inDays(2), time: "09:00", status: "ai_confirmed" });
  conv("conv-line").booking_pending = true;
  state.currentUser = { id: "agent", email: "a@test" };
  const res = await appointmentsRoute.POST(new Request("https://app.test/api/appointments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patient_name: "สมชาย", appoint_date: inDays(2), time_mode: "exact", time_start: "09:00", purpose_text: "ตรวจเลือด", conversation_id: "conv-line", booking_id: "bk1", hn: "HN42" }),
  }));
  assert.equal(res.status, 200);
  assert.equal(state.tables.bookings[0].status, "recorded");
  assert.equal(conv("conv-line").booking_pending, false);
  assert.ok(conv("conv-line").tags.includes("นัดแล้ว"));
  assert.equal(state.tables.patient_links.length, 0, "agent ทำนัดพร้อม HN ไม่ถือว่ายืนยันการจับคู่");
});

test("ข้อความนัดไม่เข้า AI: suggest ข้ามข้อความระบบ", () => {
  const src = readFileSync("src/lib/suggest.ts", "utf8");
  assert.match(src, /\.neq\("sender_type", "system"\)/);
  const storeSrc = readFileSync("src/lib/appointment-store.ts", "utf8");
  assert.doesNotMatch(storeSrc, /from "\.\/(ai|suggest|translate)"/, "ระบบนัดไม่เรียก LLM หรือแปลภาษา");
});

// ---------------------------------------------------------------------------
// ชื่อคนไข้หลังผูก HN
// ---------------------------------------------------------------------------
const contact = (id) => state.tables.contacts.find((c) => c.id === id);
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const jsonReq = (method, body, url = "https://app.test/x") => new Request(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

test("ลำดับความสำคัญของชื่อ his > staff > platform", () => {
  assert.equal(names.canOverwriteName("platform", "staff"), true);
  assert.equal(names.canOverwriteName("staff", "platform"), false);
  assert.equal(names.canOverwriteName("his", "staff"), false);
  assert.equal(names.canOverwriteName("staff", "his"), true);
  assert.equal(names.platformMayWriteDisplayName({ name_source: "staff", name_locked: true }), false);
  assert.equal(names.platformMayWriteDisplayName({ name_source: "his" }), true, "ชื่อ HIS อยู่คนละคอลัมน์");
  assert.equal(names.staffMayRename({ hn: "1" }), false, "ผูก HN แล้วชื่อ HIS ล็อก");
  assert.equal(names.staffMayRename({ hn: null }), true);
  assert.equal("aiMayWriteName" in names, false);
});

test("ชื่อที่แสดง: {ชื่อ นามสกุล} · HN และชื่อแพลตฟอร์มเป็นบรรทัดรอง", () => {
  assert.deepEqual(names.contactLabel({ display_name: "Som", platform_name: "Som", hn: "123", patient_full_name: "สมชาย ใจดี" }),
    { primary: "สมชาย ใจดี · HN 123", secondary: "Som" });
  assert.deepEqual(names.contactLabel({ display_name: "คุณเอ", platform_name: "A line", name_source: "staff" }), { primary: "คุณเอ", secondary: "A line" });
  assert.deepEqual(names.contactLabel({ display_name: "Som", platform_name: "Som" }), { primary: "Som", secondary: null });
  assert.equal(names.contactName({ display_name: "Som", hn: "9" }), "Som · HN 9", "ยังไม่มีชื่อ HIS");
  assert.equal(names.contactName(null), "ลูกค้า");
});

test("สแกน QR: ชื่อจาก iService ไม่ใช่ชื่อที่พิมพ์ และทุกแชทของ HN เดียวกันชื่อเดียวกัน", async () => {
  his.HN555 = { name: "สมชาย ใจดีมาก", phone: "0899999999" };
  // แชท Facebook ของคนเดียวกันผูก HN ไว้แล้วแต่ยังไม่มีชื่อ HIS
  Object.assign(contact("c-fb"), { hn: "HN555", patient_full_name: null, name_source: "platform" });
  addAppointment({ conversation_id: null, hn: "HN555", patient_name: "สมชาย (พิมพ์ผิด)" });
  await lineWebhook.POST(lineRequest([lineText("ยืนยันนัด #ABC234", "m-his")]));
  const c = contact("c-line");
  assert.equal(c.hn, "HN555");
  assert.equal(c.patient_full_name, "สมชาย ใจดีมาก");
  assert.equal(c.name_source, "his");
  assert.equal(contact("c-fb").patient_full_name, "สมชาย ใจดีมาก");
  assert.equal(names.contactName(c), "สมชาย ใจดีมาก · HN HN555");
  const log = state.tables.patient_link_events.at(-1);
  assert.deepEqual([log.action, log.via, log.name_source, log.staff_id], ["link", "link_code", "his", null]);
});

test("สแกน QR แต่ iService ไม่มีข้อมูล: ใช้ชื่อในนัดเป็นชื่อ HIS เฉพาะเมื่อชื่อนั้นมาจาก iService", async () => {
  addAppointment({ conversation_id: null, hn: "HN1", patient_name: "จาก HIS", name_from_his: true });
  await lineWebhook.POST(lineRequest([lineText("ยืนยันนัด #ABC234", "m-x")]));
  assert.equal(contact("c-line").name_source, "his");
  assert.equal(contact("c-line").patient_full_name, "จาก HIS");
});

test("ชื่อจากแพลตฟอร์มไม่ทับชื่อที่ตั้งไว้ แต่ยังเก็บไว้ค้นหา", async () => {
  Object.assign(contact("c-line"), { display_name: "คุณสมชาย", name_locked: true, name_source: "staff", platform_name: "old" });
  await storeIncoming({ channelType: "line", externalId: LINE_USER, text: "สวัสดี", displayName: "Somchai LINE" });
  assert.equal(contact("c-line").display_name, "คุณสมชาย");
  assert.equal(contact("c-line").platform_name, "Somchai LINE");
  Object.assign(contact("c-ig"), { display_name: "IG user", name_locked: false, name_source: "his", hn: "7", patient_full_name: "ชื่อ HIS" });
  await storeIncoming({ channelType: "instagram", externalId: IG_USER, text: "hi", displayName: "ig.new" });
  assert.equal(contact("c-ig").patient_full_name, "ชื่อ HIS", "ชื่อ HIS ไม่ถูกแตะ");
  assert.equal(contact("c-ig").name_source, "his");
});

test("ปุ่มแก้ชื่อ: เจ้าหน้าที่ตั้งชื่อได้ (staff) แต่แชทที่ผูก HN แล้วแก้ไม่ได้", async () => {
  state.currentUser = { id: "agent", email: "a@test" };
  const ok = await contactRoute.PATCH(jsonReq("PATCH", { displayName: "คุณสมชาย" }), ctx("conv-line"));
  assert.equal(ok.status, 200);
  assert.equal(contact("c-line").name_source, "staff");
  assert.equal(contact("c-line").display_name, "คุณสมชาย");

  Object.assign(contact("c-line"), { hn: "5", patient_full_name: "ชื่อ HIS", name_source: "his" });
  const res = await contactRoute.PATCH(jsonReq("PATCH", { displayName: "ชื่อเล่น" }), ctx("conv-line"));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /ยกเลิกการผูก/);
  assert.equal(contact("c-line").display_name, "คุณสมชาย");
  // เจ้าหน้าที่ตั้งชื่อแชทเองไว้ (name_locked): ผูก HN แล้วชื่อแชทยังเป็นชื่อที่ตั้ง ไม่ถูกชื่อ HIS เขียนทับ
  assert.equal(names.contactName(contact("c-line")), "คุณสมชาย");
  assert.equal(names.contactName({ ...contact("c-line"), name_locked: false }), "ชื่อ HIS · HN 5");
});

test("migration 038: ชื่อที่ AI ตั้งคืนเป็นชื่อแพลตฟอร์ม หรือชื่อ HIS ถ้าผูกแล้ว และไม่มี ai ใน name_source", () => {
  const sql = readFileSync("supabase/migrations/038_remove_ai_names.sql", "utf8");
  assert.match(sql, /display_name = coalesce\(\s*ct\.platform_name/);
  assert.match(sql, /when ct\.hn is not null and ct\.patient_full_name is not null then 'his' else 'platform'/);
  assert.match(sql, /check \(name_source in \('his', 'staff', 'platform'\)\)/);
});

test("แอดมินยืนยันการจับคู่ HN และยกเลิกการผูก: กลับไปใช้ชื่อเดิมและเก็บ log ว่าใครทำ", async () => {
  his["900"] = { name: "มานี มีนา", phone: "0811111111" };
  state.currentUser = { id: "agent", email: "a@test" };
  assert.equal((await patientLinkRoute.POST(jsonReq("POST", { hn: "900" }), ctx("conv-line"))).status, 403, "agent ผูกเองไม่ได้");

  state.currentUser = { id: "adm", email: "adm@test" };
  const pre = await patientLinkRoute.GET(new Request("https://app.test/x?hn=900"), ctx("conv-line"));
  assert.deepEqual(await pre.json(), { hn: "900", name: "มานี มีนา" });
  assert.equal((await patientLinkRoute.GET(new Request("https://app.test/x?hn=404"), ctx("conv-line"))).status, 404);

  const res = await patientLinkRoute.POST(jsonReq("POST", { hn: "900" }), ctx("conv-line"));
  assert.equal(res.status, 200);
  assert.equal(names.contactName(contact("c-line")), "มานี มีนา · HN 900");
  const a = addAppointment({ hn: "900", conversation_id: "conv-line" });

  const del = await patientLinkRoute.DELETE(jsonReq("DELETE"), ctx("conv-line"));
  assert.equal(del.status, 200);
  const c = contact("c-line");
  assert.equal(c.hn, null);
  assert.equal(c.patient_full_name, null);
  assert.equal(c.name_source, "platform");
  assert.equal(names.contactName(c), "สมชาย");
  assert.equal(appt(a.id).conversation_id, null, "ไม่ส่งข้อความนัดเข้าแชทที่ยกเลิกการผูกแล้ว");
  assert.equal(state.tables.patient_links.length, 0);
  const log = state.tables.patient_link_events.at(-1);
  assert.deepEqual([log.action, log.staff_id, log.hn], ["unlink", "adm", "900"]);
});

test("แอดมินทำนัดจากแชทพร้อม HN = ยืนยันการจับคู่ ใช้ชื่อจาก iService", async () => {
  his.HN42 = { name: "ชื่อจริง HIS", phone: "" };
  state.currentUser = { id: "adm", email: "adm@test" };
  await appointmentsRoute.POST(jsonReq("POST", { patient_name: "ชื่อที่พิมพ์", hn: "HN42", appoint_date: inDays(2), time_mode: "exact", time_start: "09:00", conversation_id: "conv-line" }));
  assert.equal(contact("c-line").patient_full_name, "ชื่อจริง HIS");
  assert.equal(state.tables.patient_link_events.at(-1).staff_id, "adm");
});

// ---------------------------------------------------------------------------
// ช่วงเวลา เวลาเปิดคลินิก preset เหตุผลนัด การปฏิบัติตัว
// ---------------------------------------------------------------------------
const SCHEDULE = { hours: rules.DEFAULT_CLINIC_HOURS, closures: { "2030-01-07": "หยุดชดเชย" } };
// 2030-01-05 เสาร์, 2030-01-06 อาทิตย์, 2030-01-07 จันทร์ (หยุดพิเศษ), 2030-01-08 อังคาร

test("วลีเวลา: ช่วงเวลา (ตรวจตามลำดับคิว) และเวลาตรง", () => {
  const slot = { time_mode: "slot", time_start: "08:00", time_end: "12:00" };
  const exact = { time_mode: "exact", time_start: "09:30", time_end: null };
  assert.equal(rules.timePhrase(slot), "เวลา 08:00–12:00 น. (ตรวจตามลำดับคิว)");
  assert.equal(rules.timePhrase(exact), "เวลา 09:30 น.");
  assert.equal(rules.timePhrase(slot, "en"), "Time 08:00–12:00 (Seen in queue order)");
  assert.equal(rules.timePhrase(exact, "en"), "Time 09:30");
  assert.equal(rules.timeShort(slot), "08:00–12:00");
});

test("เวลาเปิด: จ–ศ เช้า+บ่าย เสาร์–อาทิตย์ เช้าอย่างเดียว วันหยุดพิเศษปิด", () => {
  assert.deepEqual(rules.slotsForDate("2030-01-08", SCHEDULE).map((s) => s.slot_id), ["morning", "afternoon"]);
  assert.deepEqual(rules.slotsForDate("2030-01-05", SCHEDULE).map((s) => s.slot_id), ["morning"]);
  assert.deepEqual(rules.slotsForDate("2030-01-07", SCHEDULE), []);
  assert.equal(rules.isClosedDate("2030-01-07", SCHEDULE), true);
  assert.equal(rules.nextOpenDate("2030-01-07", SCHEDULE), "2030-01-08");
  const closedSunday = { hours: { ...rules.DEFAULT_CLINIC_HOURS, 0: [] }, closures: { "2030-01-07": "" } };
  assert.equal(rules.nextOpenDate("2030-01-05", closedSunday), "2030-01-08", "ข้ามอาทิตย์ปิดและวันหยุดพิเศษ");
  assert.equal(rules.isWithinOpenHours("2030-01-08", "09:00", SCHEDULE), true);
  assert.equal(rules.isWithinOpenHours("2030-01-08", "12:30", SCHEDULE), false, "พักกลางวัน");
  assert.equal(rules.isWithinOpenHours("2030-01-08", "18:00", SCHEDULE), false);
  assert.equal(rules.isWithinOpenHours("2030-01-05", "14:00", SCHEDULE), false, "เสาร์บ่ายปิด");
});

test("วันนัดแบบตัวเลข + หน่วย นับจากวันนี้", () => {
  assert.equal(rules.relativeDate("2030-01-31", 10, "day"), "2030-02-10");
  assert.equal(rules.relativeDate("2030-01-02", 6, "week"), "2030-02-13");
  assert.equal(rules.relativeDate("2030-01-31", 1, "month"), "2030-02-28");
  assert.equal(rules.relativeDate("2030-01-02", -1, "day"), null);
  assert.equal(rules.relativeDate("2030-01-02", Number.NaN, "day"), null);
});

const nextWeekday = (wd) => { for (let i = 1; i <= 7; i++) { const d = inDays(i); if (rules.weekdayOf(d) === wd) return d; } };

test("ลงนัดแบบช่วง: ระบบใช้เวลาจาก clinic_hours ไม่เชื่อเวลาจากหน้าเว็บ และส่งวลีช่วงเวลา", async () => {
  const tue = nextWeekday(2);
  const { appointment } = await store.createAppointment({
    patient_name: "สมชาย", appoint_date: tue, time_mode: "slot", slot_id: "afternoon", time_start: "03:00", conversation_id: "conv-line",
  }, "agent");
  const a = appt(appointment.id);
  assert.deepEqual([a.time_mode, a.slot_id, a.time_start, a.time_end], ["slot", "afternoon", "13:00", "18:00"]);
  const flex = linePosts()[0].body.messages[0];
  assert.match(flex.altText, /เวลา 13:00–18:00 น\. \(ตรวจตามลำดับคิว\)/);

  const sat = nextWeekday(6);
  await assert.rejects(store.createAppointment({ patient_name: "x", appoint_date: sat, time_mode: "slot", slot_id: "afternoon" }, "agent"), /ไม่มีช่วงเวลานี้/);
  // เวลาตรงนอกเวลาทำการบันทึกได้ (หน้าเว็บให้ยืนยันก่อน)
  const { appointment: lunch } = await store.createAppointment({ patient_name: "y", appoint_date: tue, time_mode: "exact", time_start: "12:30" }, "agent");
  assert.deepEqual([appt(lunch.id).time_mode, appt(lunch.id).time_start, appt(lunch.id).time_end], ["exact", "12:30", null]);
});

test("preset เหตุผลนัด: ชื่อมาจาก preset การปฏิบัติตัวส่งเสมอ แต่ชื่อเหตุผลไม่ส่งตามค่าเริ่มต้น", async () => {
  const { appointment } = await store.createAppointment({
    patient_name: "สมชาย", appoint_date: inDays(3), time_mode: "exact", time_start: "08:30", conversation_id: "conv-line",
    purpose_id: PURPOSE_BLOOD, instructions: "งดน้ำงดอาหาร 8–12 ชม. (ดื่มน้ำเปล่าได้)",
  }, "agent");
  assert.equal(appt(appointment.id).purpose_text, "เจาะเลือด");
  assert.equal(appt(appointment.id).purpose_id, PURPOSE_BLOOD);
  const flex = linePosts()[0].body.messages[0];
  assert.match(flex.altText, /การปฏิบัติตัว: งดน้ำงดอาหาร/);
  assert.doesNotMatch(JSON.stringify(flex), /เจาะเลือด/, "send_purpose_in_message = false");
  assert.match(JSON.stringify(flex.contents.body), /งดน้ำงดอาหาร/);

  // เตือนก่อนวันนัดก็มีการปฏิบัติตัว
  outbound = [];
  const tomorrowAppt = addAppointment({ appoint_date: inDays(1), instructions: "กรุณานำยาเดิมมาด้วย", link_code: "MED111" });
  await store.runAppointmentReminders(Date.parse(`${today}T16:00:00+07:00`));
  assert.ok(appt(tomorrowAppt.id).reminder_sent_at);
  assert.match(linePosts()[0].body.messages[0].altText, /กรุณานำยาเดิมมาด้วย/);

  await assert.rejects(store.createAppointment({ patient_name: "x", appoint_date: inDays(3), time_mode: "exact", time_start: "09:00", purpose_id: "not-a-uuid" }, "agent"), /เหตุผลนัดไม่ถูกต้อง/);
});

test("ข้อมูลฟอร์ม: preset ที่เปิดใช้เรียงตาม sort_order และเวลาเปิดคลินิก", async () => {
  const data = await store.appointmentFormData(null);
  assert.deepEqual(data.presets.map((p) => p.name), ["ฟังผลแล็บ", "เจาะเลือด"]);
  assert.deepEqual(data.schedule.hours[6].map((s) => s.slot_id), ["morning"]);
  assert.equal(data.schedule.hours[3][1].end, "18:00");
});

test("นัดไว้แล้วต่อวันและต่อช่วง นับเฉพาะนัดที่ยังเปิดอยู่", async () => {
  const d = inDays(5);
  addAppointment({ appoint_date: d, time_mode: "slot", slot_id: "morning", time_start: "08:00", time_end: "12:00", link_code: "C00001" });
  addAppointment({ appoint_date: d, time_mode: "slot", slot_id: "morning", time_start: "08:00", time_end: "12:00", status: "confirmed", link_code: "C00002" });
  addAppointment({ appoint_date: d, time_mode: "exact", time_start: "15:00", status: "reschedule_requested", link_code: "C00003" });
  addAppointment({ appoint_date: d, time_mode: "slot", slot_id: "afternoon", time_start: "13:00", time_end: "18:00", status: "cancelled", link_code: "C00004" });
  const counts = await store.appointmentDayCounts(d, d);
  assert.deepEqual(counts[d], { total: 3, slots: { morning: 2, exact: 1 } });
});

test("ใบนัดและหน้าจอใช้คอลัมน์ใหม่: ไม่มี appoint_time/purpose เดิมหลงเหลือ", () => {
  for (const f of ["src/app/(staff)/appointments/[id]/print/print-client.tsx", "src/lib/appointment-slip.ts", "src/app/(staff)/appointments/appointments-client.tsx", "src/lib/appointment-store.ts", "src/lib/appointment-rules.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /appoint_time|(?<!opts|src|out)\.purpose\b/, f);
  }
  const slip = readFileSync("src/lib/appointment-slip.ts", "utf8");
  assert.match(slip, /slipTime\(a, lang\)/);
  assert.match(slip, /a\.instructions/);
  assert.match(slip, /a\.purpose_text/);
});

// ---------------------------------------------------------------------------
// หน้านัดหมายเฉพาะคนไข้ที่มี HN / คนไข้ใหม่จับคู่ HN หลังมาตรวจ
// ---------------------------------------------------------------------------
test("หน้านัดหมายทำนัดได้เฉพาะคนไข้ที่มี HN คนไข้ใหม่ทำจากแชทได้", async () => {
  const res = await appointmentsRoute.POST(jsonReq("POST", { patient_name: "คนใหม่", appoint_date: inDays(3), time_mode: "slot", slot_id: "morning" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /คนไข้ใหม่ให้ทำนัดจากแชท/);
  state.currentUser = { id: "agent", email: "a@test" };
  const fromChat = await appointmentsRoute.POST(jsonReq("POST", { patient_name: "คนใหม่", phone: "0811112222", appoint_date: inDays(3), time_mode: "slot", slot_id: "morning", conversation_id: "conv-line" }));
  assert.equal(fromChat.status, 200);
  assert.equal((await fromChat.json()).appointment.hn, null);
});

test("ยืนยันจับคู่ HN: ผูกแชท ชื่อจริง·HN นัดเป็น attended และปัดตกข้อเสนออื่น", async () => {
  his["000004714"] = { name: "นางมานี ใจดี", phone: "0811112222" };
  const a = addAppointment({ hn: null, patient_name: "มานี", phone: "0811112222", appoint_date: today, link_code: "NEW001" });
  state.tables.appointment_hn_matches = [
    { id: "m1", appointment_id: a.id, hn: "000004714", his_name: "นางมานี ใจดี", matched_by: "name_phone", status: "pending" },
    { id: "m2", appointment_id: a.id, hn: "000009999", his_name: "นางมานี ใจดี", matched_by: "name", status: "pending" },
  ];
  assert.deepEqual(await store.decideHnMatch("m1", true, "adm"), { status: "attended" });
  assert.deepEqual([appt(a.id).hn, appt(a.id).patient_name, appt(a.id).status], ["000004714", "นางมานี ใจดี", "attended"]);
  assert.equal(names.contactName(contact("c-line")), "นางมานี ใจดี · HN 000004714");
  assert.deepEqual(state.tables.appointment_hn_matches.map((m) => m.status), ["accepted", "rejected"]);
  await assert.rejects(store.decideHnMatch("m2", true, "adm"), /ตัดสินไปแล้ว/);
});

test("ปฏิเสธจับคู่ทุกข้อเสนอ: นัดเป็น no_show", async () => {
  const a = addAppointment({ hn: null, patient_name: "ชูใจ", appoint_date: today, link_code: "NEW002" });
  state.tables.appointment_hn_matches = [{ id: "m3", appointment_id: a.id, hn: "123", his_name: "ชูใจ", matched_by: "name", status: "pending" }];
  assert.deepEqual(await store.decideHnMatch("m3", false, "adm"), { status: "no_show" });
  assert.equal(appt(a.id).status, "no_show");
  assert.equal(contact("c-line").hn ?? null, null, "ไม่ผูก HN");
});

// ---------------------------------------------------------------------------
// แก้ไข / ยกเลิก / กู้คืน
// ---------------------------------------------------------------------------
test("เปลี่ยนวันนัด: link_code เดิม เตือนใหม่ ข้อความแสดงวันเดิม→วันใหม่พร้อมปุ่ม และปิดงานเลื่อนนัด", async () => {
  const a = addAppointment({ status: "reschedule_requested", reminder_sent_at: nextTime(), link_code: "KEEP01" });
  state.tables.chat_tasks.push({ id: "t1", conversation_id: "conv-line", text: "เลื่อนนัด: คนไข้ขอเลื่อนนัด", done: false, created_at: nextTime() });
  conv("conv-line").open_tasks = 1;
  const r = await store.updateAppointment(a.id, { appoint_date: inDays(21) }, "nurse");
  assert.equal(r.moved, true);
  assert.deepEqual([appt(a.id).status, appt(a.id).reminder_sent_at, appt(a.id).link_code], ["scheduled", null, "KEEP01"]);
  const flex = linePosts()[0].body.messages[0];
  assert.match(flex.altText, /เปลี่ยนวันนัดใหม่\nจากเดิม /);
  assert.ok(flex.contents.footer, "มีปุ่มยืนยัน/ขอเลื่อน");
  assert.equal(state.tables.chat_tasks[0].done, true);
  assert.equal(conv("conv-line").open_tasks, 0);

  outbound = [];
  const r2 = await store.updateAppointment(a.id, { note: "นำบัตรมาด้วย", purpose_text: "ติดตามอาการ" }, "nurse");
  assert.equal(r2.moved, false);
  assert.equal(r2.delivery, null);
  assert.equal(outbound.length, 0, "แก้หมายเหตุ/เหตุผลไม่ส่งข้อความ");
});

test("ยกเลิกต้องมีเหตุผล ลงนัดผิดไม่ส่งข้อความ กู้คืนได้วันเดียวกันกลับสถานะเดิม", async () => {
  const a = addAppointment({ status: "confirmed", link_code: "CAN100" });
  await assert.rejects(store.cancelAppointment(a.id, "nurse", {}), /เลือกเหตุผล/);
  await assert.rejects(store.cancelAppointment(a.id, "nurse", { code: "other" }), /พิมพ์เหตุผล/);
  const r = await store.cancelAppointment(a.id, "nurse", { code: "mistake" });
  assert.equal(r.delivery, null);
  assert.equal(outbound.filter((o) => o.url.includes("api.line.me/v2/bot/message")).length, 0);
  assert.deepEqual([appt(a.id).status, appt(a.id).cancel_reason, appt(a.id).cancel_reason_code, appt(a.id).cancelled_by], ["cancelled", "ลงนัดผิด", "mistake", "nurse"]);
  assert.ok(appt(a.id).cancelled_at);
  assert.equal(rules.deliveryState(appt(a.id)), "closed", "ไม่เข้าคิวโทร");

  await store.restoreAppointment(a.id, "nurse");
  assert.deepEqual([appt(a.id).status, appt(a.id).cancel_reason], ["confirmed", null]);
  assert.ok(state.tables.appointment_events.some((e) => e.appointment_id === a.id && e.kind === "restored" && e.staff_id === "nurse"));

  await store.cancelAppointment(a.id, "nurse", { code: "doctor" });
  assert.match(linePosts().at(-1).body.messages[0].altText, /ยกเลิกนัด/, "แพทย์ยกเลิก = แจ้งคนไข้");
  // ยกเลิกเมื่อวาน กู้คืนไม่ได้
  appt(a.id).cancelled_at = new Date(Date.now() - 86_400_000 * 2).toISOString();
  await assert.rejects(store.restoreAppointment(a.id, "nurse"), /เฉพาะนัดที่ยกเลิกวันนี้/);
});

test("นัดที่มาแล้ว/ไม่มา ดูได้อย่างเดียว", async () => {
  for (const status of ["attended", "no_show"]) {
    const a = addAppointment({ status, link_code: status === "attended" ? "ATT001" : "NOS001" });
    await assert.rejects(store.updateAppointment(a.id, { note: "x" }, "nurse"), /แก้ไม่ได้/);
    await assert.rejects(store.cancelAppointment(a.id, "nurse", { code: "patient" }), /ยกเลิกแล้ว|ไม่มา/);
    assert.equal(rules.isEditable(a), false);
  }
});

// ---------------------------------------------------------------------------
// ชุดนัด (series) และการเลือกวันด้วยตัวเลข
// ---------------------------------------------------------------------------
test("preset default_days → ช่องวัน หรือช่องเดือนถ้าหาร 30 ลงตัว", () => {
  assert.deepEqual(rules.offsetFromDays(7), { value: 7, unit: "day" });
  assert.deepEqual(rules.offsetFromDays(30), { value: 1, unit: "month" });
  assert.deepEqual(rules.offsetFromDays(90), { value: 3, unit: "month" });
  assert.equal(rules.thaiMediumDate("2026-11-23"), "จันทร์ 23 พ.ย. 2569");
});

test("เลื่อนนัดถัดไปตาม: เฉพาะที่นับจากนัดก่อนหน้าเป็นทอดๆ แก้นัดแรกแล้วที่นับจากนัดแรกเลื่อนด้วย", () => {
  const items = [
    { seq: 1, date: "2030-01-01", from: null, value: null, unit: null },
    { seq: 2, date: "2030-02-01", from: "previous", value: 1, unit: "month" },
    { seq: 3, date: "2030-07-01", from: "previous", value: 5, unit: "month" },
    { seq: 4, date: "2031-01-01", from: "first", value: 12, unit: "month" },
  ];
  assert.deepEqual(rules.shiftFollowing(items, 2, "2030-02-10"), [{ seq: 3, date: "2030-07-10" }], "นัดที่ 4 นับจากนัดแรกไม่เลื่อน");
  assert.deepEqual(rules.shiftFollowing(items, 1, "2030-01-05"),
    [{ seq: 2, date: "2030-02-05" }, { seq: 3, date: "2030-07-05" }, { seq: 4, date: "2031-01-05" }]);
});

test("ชุดนัด 3 นัด: การ์ดเดียวทุกนัด → แก้นัดที่ 2 เลื่อนตาม → ยกเลิกเฉพาะนัดที่ 3 → เตือนบอก เข็ม N จาก M", async () => {
  const d1 = inDays(2);
  const r = await store.createAppointment({
    patient_name: "สมชาย", hn: "HN900", appoint_date: d1, time_mode: "slot", slot_id: "morning", conversation_id: "conv-line",
    purpose_text: "วัคซีน", series_label: "เข็ม 1", series_title: "วัคซีน 3 เข็ม",
    series_items: [
      { label: "เข็ม 2", appoint_date: rules.addDays(d1, 30), time_mode: "slot", slot_id: "morning", from: "previous", offset_value: 30, offset_unit: "day" },
      { label: "เข็ม 3", appoint_date: rules.addDays(d1, 180), time_mode: "slot", slot_id: "morning", from: "first", offset_value: 180, offset_unit: "day" },
    ],
  }, "nurse");
  const seriesId = r.appointment.series_id;
  assert.ok(seriesId);
  const items = () => state.tables.appointments.filter((a) => a.series_id === seriesId).sort((a, b) => a.series_seq - b.series_seq);
  assert.deepEqual(items().map((a) => [a.series_seq, a.series_label]), [[1, "เข็ม 1"], [2, "เข็ม 2"], [3, "เข็ม 3"]]);
  assert.equal(new Set(items().map((a) => a.link_code)).size, 3);
  // การ์ดเดียว แสดงทุกนัด ปุ่มยืนยันเป็นของนัดแรก
  assert.equal(linePosts().length, 1);
  const flex = linePosts()[0].body.messages[0];
  assert.match(flex.altText, /ตารางนัดทั้งชุด:\n• เข็ม 1: .*\n• เข็ม 2: .*\n• เข็ม 3: /);
  assert.equal(flex.contents.footer.contents[0].action.data, `appt:confirm:${r.appointment.id}`);
  assert.ok(items().every((a) => a.confirm_sent_at), "ทุกนัดในชุดถือว่าส่งแล้ว");

  // แก้วันนัดที่ 2 + เลื่อนนัดถัดไปตาม: เข็ม 3 นับจากเข็มแรก จึงไม่เลื่อน
  outbound = [];
  const second = items()[1];
  const third = items()[2];
  const thirdDate = third.appoint_date;
  const u = await store.updateAppointment(second.id, { appoint_date: rules.addDays(second.appoint_date, 7), shift_following: true }, "nurse");
  assert.equal(u.moved, true);
  assert.equal(u.shifted, 0);
  assert.equal(items()[2].appoint_date, thirdDate);
  // เปลี่ยนเข็ม 3 ให้นับจากนัดก่อนหน้า แล้วเลื่อนเข็ม 2 อีกครั้ง → เข็ม 3 เลื่อนตาม
  items()[2].series_from = "previous";
  items()[2].series_offset_value = 150;
  const newSecond = rules.addDays(items()[1].appoint_date, 3);
  const u2 = await store.updateAppointment(second.id, { appoint_date: newSecond, shift_following: true }, "nurse");
  assert.equal(u2.shifted, 1);
  assert.equal(items()[2].appoint_date, rules.addDays(newSecond, 150));
  assert.equal(items()[2].reminder_sent_at, null);
  assert.match(linePosts().at(-1).body.messages[0].altText, /เปลี่ยนวันนัดใหม่[\s\S]*ตารางนัดทั้งชุด/);

  // ยกเลิกเฉพาะนัดที่ 3
  await store.cancelAppointment(items()[2].id, "nurse", { code: "doctor", scope: "one" });
  assert.deepEqual(items().map((a) => a.status), ["scheduled", "scheduled", "cancelled"]);

  // เตือนนัดที่ 2: เข็ม 2 จาก 2 (นับเฉพาะที่ไม่ยกเลิก)
  outbound = [];
  items()[1].appoint_date = inDays(1);
  items()[1].reminder_attempted_at = null;
  items()[1].confirm_sent_at = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await store.runAppointmentReminders(Date.parse(`${today}T16:00:00+07:00`));
  assert.match(linePosts()[0].body.messages[0].altText, /เตือนนัดพรุ่งนี้ · เข็ม 2 จาก 2/);
});

test("ยกเลิกทั้งชุด: นัดที่ยังเปิดอยู่ทั้งหมดถูกยกเลิก ข้อความเดียว", async () => {
  const d1 = inDays(3);
  const r = await store.createAppointment({
    patient_name: "สมหญิง", hn: "HN901", appoint_date: d1, time_mode: "slot", slot_id: "morning", conversation_id: "conv-line",
    series_items: [{ label: "เข็ม 2", appoint_date: rules.addDays(d1, 14), time_mode: "slot", slot_id: "morning", from: "previous", offset_value: 2, offset_unit: "week" }],
  }, "nurse");
  outbound = [];
  const res = await store.cancelAppointment(r.appointment.id, "nurse", { code: "patient", scope: "series" });
  assert.equal(res.cancelled, 2);
  assert.ok(state.tables.appointments.filter((a) => a.series_id === r.appointment.series_id).every((a) => a.status === "cancelled"));
  assert.equal(linePosts().length, 1);
  assert.match(linePosts()[0].body.messages[0].altText, /ยกเลิกนัด[\s\S]*เข็ม 2/);
});

// ---------------------------------------------------------------------------
// วันนี้ฉีดเข็มที่ N: นัดแรกเป็นเข็ม N+1 และเข็มที่ฉีดแล้วอยู่ในตารางชุด
// ---------------------------------------------------------------------------
const TEMPLATE_5 = [
  { label: "เข็ม 1", offset_value: 0, offset_unit: "day", from: "first" },
  { label: "เข็ม 2", offset_value: 1, offset_unit: "month", from: "first" },
  { label: "เข็ม 3", offset_value: 6, offset_unit: "month", from: "first" },
  { label: "เข็ม 4", offset_value: 2, offset_unit: "week", from: "previous" },
  { label: "เข็ม 5", offset_value: 1, offset_unit: "month", from: "previous" },
];

test("template: ข้ามเข็มที่ฉีดแล้ว นับจากเข็ม 1 หรือเข็มก่อนหน้า (เข็ม N+1 นับจากวันนี้)", () => {
  const plan = rules.planFromTemplate(TEMPLATE_5, 3, "2030-07-01", "2030-01-01");
  assert.deepEqual(plan.map((x) => [x.dose, x.date]), [[4, "2030-07-15"], [5, "2030-08-15"]]);
  const fromToday = rules.planFromTemplate(TEMPLATE_5, 1, "2030-01-01", null);
  assert.deepEqual(fromToday.map((x) => [x.dose, x.date]), [[2, "2030-02-01"], [3, "2030-07-01"], [4, "2030-07-15"], [5, "2030-08-15"]]);
  assert.deepEqual(rules.planFromTemplate(TEMPLATE_5, 5, "2030-01-01", null), []);
});

test("วันนี้ฉีดเข็ม 3 (รู้วันเข็ม 1): บันทึกเข็ม 1, 3 ฉีดแล้ว นัดเข็ม 4, 5 การ์ดมี ✓ และเตือนบอก เข็ม 4 จาก 5", async () => {
  const d4 = inDays(14);
  const firstDose = rules.addDays(today, -180);
  const r = await store.createAppointment({
    patient_name: "สมชาย", hn: "HN950", appoint_date: d4, time_mode: "slot", slot_id: "morning", conversation_id: "conv-line",
    series_start_seq: 4, series_label: "เข็ม 4",
    series_done: [{ seq: 3, date: today }, { seq: 1, date: firstDose }, { seq: 9, date: today }, { seq: 2, date: inDays(5) }],
    series_items: [{ label: "เข็ม 5", appoint_date: rules.addDays(d4, 30), time_mode: "slot", slot_id: "morning", from: "previous", offset_value: 1, offset_unit: "month" }],
  }, "nurse");
  const all = state.tables.appointments.filter((a) => a.series_id === r.appointment.series_id).sort((a, b) => a.series_seq - b.series_seq);
  assert.deepEqual(all.map((a) => [a.series_seq, a.series_label, a.status, !!a.series_done]),
    [[1, "เข็ม 1", "attended", true], [3, "เข็ม 3", "attended", true], [4, "เข็ม 4", "scheduled", false], [5, "เข็ม 5", "scheduled", false]],
    "เข็ม 9 (เกินนัดแรก) และเข็ม 2 (วันในอนาคต) ไม่ถูกบันทึก");
  const flex = linePosts()[0].body.messages[0];
  assert.match(flex.altText, /✓ เข็ม 1: ฉีดแล้ว [\s\S]*✓ เข็ม 3: ฉีดแล้ว [\s\S]*• เข็ม 4: [\s\S]*• เข็ม 5: /);
  assert.equal(flex.contents.footer.contents[0].action.data, `appt:confirm:${r.appointment.id}`);

  // เข็มที่ฉีดแล้วไม่อยู่ในรายการนัด ไม่นับในนัดไว้แล้ว
  const list = await store.listAppointments({ tab: "all", from: rules.addDays(today, -365) });
  assert.ok(list.every((x) => !x.series_done));
  assert.equal(list.find((x) => x.id === r.appointment.id).series_total, 5);
  const counts = await store.appointmentDayCounts(today, today);
  assert.equal(counts[today]?.total ?? 0, 0);

  // เตือนเข็ม 4
  outbound = [];
  const d = all[2];
  d.appoint_date = inDays(1);
  d.confirm_sent_at = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await store.runAppointmentReminders(Date.parse(`${today}T16:00:00+07:00`));
  assert.match(linePosts()[0].body.messages[0].altText, /เตือนนัดพรุ่งนี้ · เข็ม 4 จาก 5/);
});

// ---------------------------------------------------------------------------
// LINE follow/unfollow, ใบนัดไม่พิมพ์ QR เมื่อผูก LINE แล้ว, กล่องขวาตาม HN
// ---------------------------------------------------------------------------
test("LINE unfollow: ข้อความนัดขึ้นส่งไม่ได้-ต้องโทร follow กลับแล้วส่งได้", async () => {
  const unfollow = { type: "unfollow", webhookEventId: "uf-1", source: { type: "user", userId: LINE_USER } };
  await lineWebhook.POST(lineRequest([unfollow]));
  assert.ok(contact("c-line").line_unfollowed_at);
  const r = await store.createAppointment({ patient_name: "สมชาย", appoint_date: inDays(3), time_mode: "slot", slot_id: "morning", conversation_id: "conv-line" }, "agent");
  assert.equal(r.delivery.sent, false);
  assert.match(r.delivery.error, /เลิกติดตาม/);
  assert.equal(linePosts().length, 0);
  const slip = await store.appointmentSlip(r.appointment.id);
  assert.equal(slip.linkedLine, false, "เลิกติดตามแล้ว พิมพ์ QR ให้สแกนใหม่");

  await lineWebhook.POST(lineRequest([{ type: "follow", webhookEventId: "f-1", replyToken: "rt-f", source: { type: "user", userId: LINE_USER } }]));
  assert.equal(contact("c-line").line_unfollowed_at, null);
  assert.equal((await store.appointmentSlip(r.appointment.id)).linkedLine, true, "ผูก LINE และติดตามอยู่ ใบนัดบอกว่าผูกแล้ว (ยังพิมพ์ QR ให้ญาติสแกนเพิ่ม)");
  assert.equal(calls.chat, 0);
});

test("ใบนัด: ไม่มีแชทหรือแชท Facebook ยังพิมพ์ QR", async () => {
  const none = addAppointment({ conversation_id: null, link_code: "QR0001" });
  const fb = addAppointment({ conversation_id: "conv-fb", link_code: "QR0002" });
  assert.equal((await store.appointmentSlip(none.id)).linkedLine, false);
  assert.equal((await store.appointmentSlip(fb.id)).linkedLine, false);
  // QR + รหัสพิมพ์ทุกใบ ไม่มีเงื่อนไขซ่อน
  const src = readFileSync("src/app/(staff)/appointments/[id]/print/print-client.tsx", "utf8");
  assert.match(src, /<div className={`appt-slip-qr mm\$\{view\.qr\.sizeMm\}`} dangerouslySetInnerHTML/);
  assert.doesNotMatch(src, /พิมพ์ QR ด้วย/);
});

test("กล่องขวาของแชท: แสดงนัดทุกนัดของ HN ที่ผูก (รวมนัดที่ทำจากหน้านัดหมาย) ไม่ซ้ำ ไม่รวมเข็มที่ฉีดแล้ว", async () => {
  const route = await import("../src/app/api/conversations/[id]/appointments/route.ts");
  state.currentUser = { id: "agent", email: "a@test" };
  state.tables.patient_links.push({ conversation_id: "conv-line", hn: "HN77", linked_at: nextTime() });
  const fromPage = addAppointment({ hn: "HN77", conversation_id: null, link_code: "PG0001", appoint_date: inDays(5) });
  const fromChat = addAppointment({ hn: null, conversation_id: "conv-line", link_code: "CH0001", appoint_date: inDays(2) });
  const both = addAppointment({ hn: "HN77", conversation_id: "conv-line", link_code: "BT0001", appoint_date: inDays(9) });
  addAppointment({ hn: "HN77", conversation_id: null, link_code: "DN0001", appoint_date: today, status: "attended", series_done: true });
  addAppointment({ hn: "OTHER", conversation_id: null, link_code: "OT0001" });
  const res = await route.GET(new Request("https://app.test/x"), ctx("conv-line"));
  const j = await res.json();
  // แยกกลุ่มตาม HN ที่ผูก: กลุ่ม HN77 (ทำจากหน้านัดหมาย + ทำจากแชท) และนัดของแชทที่ไม่มี HN
  assert.deepEqual(j.groups.map((g) => g.hn), ["HN77", null]);
  assert.deepEqual(j.groups[0].upcoming.map((a) => a.id), [fromPage.id, both.id]);
  assert.deepEqual(j.groups[1].upcoming.map((a) => a.id), [fromChat.id]);
  assert.equal(j.link.hn, "HN77");
});

// ---------------------------------------------------------------------------
// HN เดียวผูก LINE หลายบัญชี (คนไข้ + ญาติ)
// ---------------------------------------------------------------------------
const slipLib = await import("../src/lib/appointment-slip.ts");
const RELATIVE = "U-relative-1";
const relativeText = (text, id) => ({ type: "message", replyToken: "rt-rel", source: { type: "user", userId: RELATIVE }, message: { id, type: "text", text } });
const relativeConv = () => state.tables.conversations.find((c) => state.tables.contacts.find((x) => x.id === c.contact_id)?.external_id === RELATIVE);
function linkPatientLine(hn = "HN001") {
  state.tables.patient_links.push({ conversation_id: "conv-line", hn, patient_name: "สมชาย ใจดี", source: "link_code", linked_at: nextTime() });
  Object.assign(contact("c-line"), { hn, patient_full_name: "สมชาย ใจดี", name_source: "his", patient_relation: "patient" });
}

test("ญาติสแกน QR: เพิ่มบัญชีรับแจ้งเตือน ไม่แทนบัญชีเดิม ชื่อแชทต่อท้าย (ญาติ)", async () => {
  linkPatientLine();
  his.HN001 = { name: "สมชาย ใจดี", phone: "0812345678" };
  const a = addAppointment({ link_code: "REL234" });
  await lineWebhook.POST(lineRequest([relativeText("ยืนยันนัด #REL234", "m-rel-1")]));
  const rel = relativeConv();
  assert.ok(rel);
  assert.equal(appt(a.id).conversation_id, "conv-line", "แชทหลักยังเป็นบัญชีคนไข้");
  assert.deepEqual(state.tables.patient_links.map((l) => l.conversation_id).sort(), ["conv-line", rel.id].sort(), "HN เดียว 2 บัญชี");
  const relContact = state.tables.contacts.find((c) => c.external_id === RELATIVE);
  assert.equal(relContact.patient_relation, "relative");
  assert.equal(contact("c-line").patient_relation, "patient");
  assert.match(names.contactName(relContact), /^สมชาย ใจดี · HN HN001 \(ญาติ\)$/);
  assert.equal(names.contactName(contact("c-line")), "สมชาย ใจดี · HN HN001");
  // ข้อความนัดตอบเฉพาะบัญชีที่สแกน (replyToken ของญาติ)
  const replies = linePosts().filter((o) => o.url.endsWith("/reply"));
  assert.deepEqual(replies.map((o) => o.body.replyToken), ["rt-rel"]);
  assert.equal(linePosts().filter((o) => o.url.endsWith("/push")).length, 0, "ไม่ส่งซ้ำให้บัญชีคนไข้ตอนญาติสแกน");
  const ev = state.tables.appointment_events.find((e) => e.kind === "linked");
  assert.equal(ev.detail.added, true);
  assert.equal(ev.detail.conversation_id, rel.id);
});

test("เตือนนัดส่งทุกบัญชีที่ผูกและยังติดตาม / ปุ่มยืนยันจากบัญชีญาติมีผลและบันทึกว่าใครกด", async () => {
  linkPatientLine();
  const a = addAppointment({ link_code: "REL777" });
  await lineWebhook.POST(lineRequest([relativeText("ยืนยันนัด #REL777", "m-rel-2")]));
  const rel = relativeConv();
  // บัญชีที่สามเลิกติดตามแล้ว: ไม่ส่ง
  state.tables.contacts.push({ id: "c-gone", channel_id: "line", external_id: "U-gone", display_name: "เลิกติดตาม", language: "th", hn: "HN001", patient_relation: "relative", line_unfollowed_at: nextTime() });
  state.tables.conversations.push({ id: "conv-gone", contact_id: "c-gone", channel_id: "line", status: "closed", tags: [], unread_count: 0, open_tasks: 0, sensitive: false, archived: false });
  state.tables.patient_links.push({ conversation_id: "conv-gone", hn: "HN001", linked_at: nextTime() });

  outbound = [];
  const now = Date.parse(`${today}T16:59:00+07:00`);
  // ข้อความนัดล่าสุดส่งไปหลายวันแล้ว (ไม่ข้ามการเตือน)
  Object.assign(appt(a.id), { appoint_date: inDays(1), confirm_sent_at: new Date(now - 5 * 24 * HOUR).toISOString() });
  const r = await store.runAppointmentReminders(now);
  assert.equal(r.sent, 1);
  const pushedTo = linePosts().filter((o) => o.url.endsWith("/push")).map((o) => o.body.to).sort();
  assert.deepEqual(pushedTo, [LINE_USER, RELATIVE].sort(), "คนไข้ + ญาติ ไม่รวมบัญชีที่เลิกติดตาม");
  assert.ok(appt(a.id).reminder_sent_at);
  assert.equal(appt(a.id).last_send_error, null);

  // ญาติกดยืนยัน
  await lineWebhook.POST(lineRequest([{ type: "postback", webhookEventId: "ev-rel", replyToken: "rt-rp", source: { type: "user", userId: RELATIVE }, postback: { data: `appt:confirm:${a.id}` } }]));
  assert.equal(appt(a.id).status, "confirmed");
  const ev = state.tables.appointment_events.find((e) => e.kind === "confirmed" && e.appointment_id === a.id);
  assert.equal(ev.detail.conversation_id, rel.id);
  assert.equal(ev.detail.relation, "relative");
});

test("ยกเลิกการผูกบัญชีคนไข้ (แชทหลัก): นัดย้ายไปบัญชีที่เหลือ บัญชีที่ยกเลิกกดปุ่มไม่ได้แล้ว", async () => {
  linkPatientLine();
  const a = addAppointment({ link_code: "REL888" });
  await lineWebhook.POST(lineRequest([relativeText("ยืนยันนัด #REL888", "m-rel-3")]));
  const rel = relativeConv();
  const ok = await store.detachAccount(a.id, "conv-line", "adm");
  assert.equal(ok, true);
  assert.equal(appt(a.id).conversation_id, rel.id, "แชทหลักย้ายไปบัญชีญาติ");
  assert.deepEqual(state.tables.patient_links.map((l) => l.conversation_id), [rel.id]);
  assert.equal(contact("c-line").hn, null);
  await lineWebhook.POST(lineRequest([linePostback(`appt:confirm:${a.id}`, "ev-old")]));
  assert.equal(appt(a.id).status, "scheduled", "บัญชีที่ยกเลิกการผูกแล้วกดไม่มีผล");
});

test("นัดไม่มี HN: บัญชีที่สแกนเพิ่มเก็บใน appointment_recipients และได้เตือนด้วย", async () => {
  const a = addAppointment({ hn: null, link_code: "NOH234", appoint_date: inDays(1) });
  await lineWebhook.POST(lineRequest([relativeText("ยืนยันนัด #NOH234", "m-rel-4")]));
  const rel = relativeConv();
  assert.equal(appt(a.id).conversation_id, "conv-line");
  assert.deepEqual(state.tables.appointment_recipients.map((r) => [r.appointment_id, r.conversation_id]), [[a.id, rel.id]]);
  const accounts = await store.linkedAccounts(appt(a.id));
  assert.deepEqual(accounts.map((x) => [x.conversation_id, x.primary, x.via]), [["conv-line", true, "code"], [rel.id, false, "code"]]);
  outbound = [];
  const now = Date.parse(`${today}T16:59:00+07:00`);
  appt(a.id).confirm_sent_at = new Date(now - 5 * 24 * HOUR).toISOString();
  await store.runAppointmentReminders(now);
  assert.equal(linePosts().filter((o) => o.url.endsWith("/push")).length, 2);
});

test("API บัญชีที่ผูก: แก้ป้ายและยกเลิกผูกได้เฉพาะแอดมิน", async () => {
  linkPatientLine();
  const a = addAppointment({ link_code: "API234" });
  const route = await import("../src/app/api/appointments/[id]/accounts/route.ts");
  const ctx = { params: Promise.resolve({ id: a.id }) };
  const UUIDC = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  state.tables.contacts.push({ id: "c-u", channel_id: "line", external_id: "U-u", display_name: "ญาติ", language: "th", hn: "HN001" });
  state.tables.conversations.push({ id: UUIDC, contact_id: "c-u", channel_id: "line", status: "closed", tags: [], unread_count: 0, open_tasks: 0, sensitive: false, archived: false });
  const patch = (body) => new Request("https://app.test/x", { method: "PATCH", body: JSON.stringify(body) });
  state.currentUser = { id: "agent", email: "a@test" };
  assert.equal((await route.PATCH(patch({ conversation_id: UUIDC, relation: "relative" }), ctx)).status, 403);
  state.currentUser = { id: "adm", email: "adm@test" };
  assert.equal((await route.PATCH(patch({ conversation_id: UUIDC, relation: "relative" }), ctx)).status, 200);
  assert.equal(contact("c-u").patient_relation, "relative");
  assert.equal((await route.PATCH(patch({ conversation_id: UUIDC, relation: "boss" }), ctx)).status, 400);
});

// ---------------------------------------------------------------------------
// ใบนัด: QR ทุกใบ ไทยเป็นค่าเริ่มต้น EN แปลอัตโนมัติตอนกดเท่านั้น
// ---------------------------------------------------------------------------
const { replies: aiReplies } = await import(fake("ai"));
const slipBase = (extra = {}) => ({
  appointment: {
    id: "a1", hn: "4714", patient_name: "สมชาย ใจดี", phone: null, conversation_id: null, appoint_date: "2026-11-23",
    time_mode: "slot", slot_id: "morning", time_start: "08:00", time_end: "12:00", purpose_id: "p", purpose_text: "เจาะเลือด",
    instructions: "งดน้ำงดอาหาร 8–12 ชม. (ดื่มน้ำเปล่าได้)", provider: "นพ.ทดสอบ", note: null,
    status: "scheduled", link_code: "ABC234", confirm_sent_at: null, reminder_sent_at: null, last_send_error: null, called_at: null, called_by: null,
  },
  series: [],
  clinic: { name: "คลินิกทดสอบ", nameEn: "HappiWell Medical Clinic", address: "ถนนสุขุมวิท", addressEn: "Sukhumvit Rd", phone: "02-000-4586" },
  linkedLine: false, issuedBy: "พยาบาล", issuedAt: "2026-11-09T07:30:00Z", ...extra,
});

test("ใบนัดไทย: หัว ชื่อ HN 9 หลัก วันนัดเต็ม ช่วงเวลา QR 40mm ยังไม่ผูก / ผูกแล้ว QR 30mm", () => {
  const v = slipLib.slipView(slipBase(), "th");
  assert.equal(v.clinicName, "คลินิกทดสอบ");
  assert.equal(v.clinicPhone, "โทร 02-000-4586");
  assert.equal(v.title, "ใบนัด");
  assert.deepEqual(v.hn, { label: "HN", value: "000004714" });
  assert.equal(v.date, "วันจันทร์ที่ 23 พฤศจิกายน 2569");
  assert.equal(v.time, "เวลา 08:00–12:00 น.", "แสดงแค่เวลา ไม่มีคำว่าช่วงเช้า/บ่าย");
  assert.equal(v.queueNote, "(ตรวจตามลำดับคิว)");
  assert.deepEqual(v.rows.map((r) => r.label), ["ผู้นัด", "เหตุผล", "การปฏิบัติตัว"]);
  assert.equal(v.qr.sizeMm, 40);
  assert.deepEqual(v.qr.below, ["สแกนแล้วกดส่ง", "เพื่อรับข้อความเตือนนัดทาง LINE"]);
  assert.equal(v.code, "#ABC234");
  assert.deepEqual(v.footer, ["หากไม่สะดวกมาตามนัด กรุณาแจ้งล่วงหน้า", "ออกโดย พยาบาล · 9 พ.ย. 2569 14:30 น."]);
  assert.doesNotMatch(JSON.stringify(v), /Appointment|Morning|Scan|Doctor|Issued|Tel /, "ใบไทยไม่มีภาษาอังกฤษปน");
  // ใบไทยไม่ใช้คำแปล แม้จะมีอยู่แล้ว
  assert.equal(slipLib.slipView(slipBase(), "th", { purpose: "Blood test" }).rows[1].value, "เจาะเลือด");

  const linked = slipLib.slipView(slipBase({ linkedLine: true }), "th");
  assert.equal(linked.qr.sizeMm, 30);
  assert.deepEqual(linked.qr.above, ["✓ ผูก LINE แล้ว", "ระบบจะแจ้งเตือนก่อนวันนัด 1 วัน"]);
  assert.deepEqual(linked.qr.below, ["ญาติหรือเบอร์ใหม่", "สแกนเพื่อรับแจ้งเตือนเพิ่มได้"]);
  assert.equal(linked.code, "#ABC234", "ผูกแล้วยังพิมพ์รหัส");
});

test("ใบนัด EN: ส่วนตายตัวเขียนในโค้ด ข้อความที่พิมพ์ใช้คำแปล ไม่มีคำแปลใช้ไทย ชื่อคน/หมอไม่แปล", () => {
  const en = { purpose: "Blood test", instructions: "Fast for 8–12 hours (plain water is OK)" };
  const v = slipLib.slipView(slipBase(), "en", en);
  assert.equal(v.clinicName, "HappiWell Medical Clinic");
  assert.equal(v.clinicAddress, "Sukhumvit Rd");
  assert.equal(v.clinicPhone, "Tel 02-000-4586");
  assert.equal(v.title, "Appointment");
  assert.equal(v.date, "Monday, 23 November 2026");
  assert.equal(v.time, "Time 08:00–12:00");
  assert.equal(v.queueNote, "(Seen in queue order)");
  assert.deepEqual(v.rows, [
    { label: "Doctor", value: "นพ.ทดสอบ" },
    { label: "Purpose", value: "Blood test", field: "purpose" },
    { label: "Instructions", value: "Fast for 8–12 hours (plain water is OK)", field: "instructions" },
  ]);
  assert.equal(v.name.value, "สมชาย ใจดี");
  assert.deepEqual(v.footer, ["Please let us know in advance if you can't make it.", "Issued by พยาบาล · 9 Nov 2026 14:30"]);
  assert.equal(slipLib.slipView(slipBase(), "en").rows[1].value, "เจาะเลือด", "แปลไม่สำเร็จ แสดงต้นฉบับไทย");
  const exact = slipLib.slipView(slipBase({ appointment: { ...slipBase().appointment, time_mode: "exact", time_start: "14:30", time_end: null } }), "en", en);
  assert.equal(exact.time, "Time 14:30");
  assert.equal(exact.queueNote, null);
  assert.equal(slipLib.slipView(slipBase({ linkedLine: true }), "en").qr.above[0], "✓ LINE linked — reminders 1 day before");
  // ข้อความที่ส่งไปแปลมีแค่เหตุผล การปฏิบัติตัว หมายเหตุ ชื่อชุดนัด
  assert.deepEqual(slipLib.slipSourceTexts(slipBase()), { purpose: "เจาะเลือด", instructions: "งดน้ำงดอาหาร 8–12 ชม. (ดื่มน้ำเปล่าได้)" });
});

test("ใบนัด series: ตารางเข็ม ✓ ฉีดแล้ว เข็มที่นัดตัวหนา เวลาในแต่ละแถว (ไม่มีช่วงเช้า/บ่าย) ชื่อชุดแปลได้", () => {
  const dose = (seq, date, extra = {}) => ({ ...slipBase().appointment, id: `d${seq}`, series_seq: seq, series_label: `เข็ม ${seq}`, appoint_date: date, ...extra });
  const series = [dose(1, "2026-11-09", { series_done: true }), dose(2, "2026-12-09"), dose(3, "2027-05-09", { time_start: "13:00", time_end: "18:00" })];
  const data = slipBase({ appointment: series[1], series, seriesTitle: null });
  const th = slipLib.slipView(data, "th");
  assert.equal(th.title, "ใบนัดวัคซีน");
  assert.equal(th.titleEditable, false);
  assert.deepEqual(th.series.map((r) => [r.label, r.when, r.current]), [
    ["✓ เข็ม 1", "ฉีดแล้ว จันทร์ 9 พ.ย. 2569", false],
    ["เข็ม 2", "พุธ 9 ธ.ค. 2569 · 08:00–12:00 น.", true],
    ["เข็ม 3", "อาทิตย์ 9 พ.ค. 2570 · 13:00–18:00 น.", false],
  ]);
  assert.equal(th.seriesNote, null);
  const en = slipLib.slipView(data, "en");
  assert.equal(en.title, "Vaccination Appointment");
  assert.deepEqual(en.series.map((r) => [r.label, r.when]), [
    ["✓ Dose 1", "Given 9 Nov 2026"],
    ["Dose 2", "Wed 9 Dec 2026 · 08:00–12:00"],
    ["Dose 3", "Sun 9 May 2027 · 13:00–18:00"],
  ]);
  assert.equal(en.seriesNote, null);
  const titled = { ...data, seriesTitle: "วัคซีนตับอักเสบบี" };
  assert.equal(slipLib.slipSourceTexts(titled).title, "วัคซีนตับอักเสบบี");
  assert.equal(slipLib.slipView(titled, "en", { title: "Hepatitis B vaccine" }).title, "Hepatitis B vaccine");
  assert.equal(slipLib.slipView(titled, "en", { title: "Hepatitis B vaccine" }).titleEditable, true);
});

test("แปลใบนัด: ส่งเฉพาะเหตุผล/การปฏิบัติตัว/หมายเหตุ ไม่ส่งชื่อ HN เบอร์ cache ต่อข้อความ แก้คำแปลใช้ครั้งถัดไป", async () => {
  state.tables.slip_translations = [];
  const a = addAppointment({ hn: "4714", patient_name: "ลับมาก นามสกุลลับ", phone: "0899999999", purpose_text: "เจาะเลือด", instructions: "งดน้ำงดอาหาร 8–12 ชม.", note: "นำผลเลือดเดิมมาด้วย" });
  aiReplies.next = { items: { 1: "Blood test", 2: "No food or drink for 8–12 hrs.", 3: "Please bring your previous blood results" } };
  const route = await import("../src/app/api/appointments/[id]/translate/route.ts");
  const ctx = { params: Promise.resolve({ id: a.id }) };
  const res = await route.POST(new Request("https://app.test/x", { method: "POST" }), ctx);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j, { en: { purpose: "Blood test", instructions: "No food or drink for 8–12 hrs.", note: "Please bring your previous blood results" }, failed: [] });
  assert.equal(calls.chat, 1);
  assert.doesNotMatch(calls.lastPrompt, /ลับมาก|นามสกุลลับ|0899999999|4714|000004714/, "ไม่ส่งชื่อ HN เบอร์ไปแปล");
  assert.match(calls.lastPrompt, /Keep every number, unit and time exactly/);
  assert.match(calls.lastPrompt, /Do not add medical advice/);
  assert.equal(state.tables.slip_translations.length, 3);

  // ข้อความ preset เดิม: ใช้ cache ไม่เรียก AI ซ้ำ
  const b = addAppointment({ hn: "5000", purpose_text: "เจาะเลือด", instructions: "งดน้ำงดอาหาร 8–12 ชม.", note: null, link_code: "TRB234" });
  const j2 = await (await route.POST(new Request("https://app.test/x", { method: "POST" }), { params: Promise.resolve({ id: b.id }) })).json();
  assert.equal(j2.en.purpose, "Blood test");
  assert.equal(calls.chat, 1, "cache hit");

  // พนักงานแก้คำแปล → ใช้คำที่แก้ครั้งถัดไป
  const put = (body) => route.PUT(new Request("https://app.test/x", { method: "PUT", body: JSON.stringify(body) }), ctx);
  assert.equal((await put({ field: "instructions", text: "Fast 8–12 hrs (water OK)" })).status, 200);
  assert.equal((await put({ field: "name", text: "x" })).status, 400, "แก้ได้เฉพาะช่องที่แปล");
  const j3 = await (await route.POST(new Request("https://app.test/x", { method: "POST" }), { params: Promise.resolve({ id: b.id }) })).json();
  assert.equal(j3.en.instructions, "Fast 8–12 hrs (water OK)");
  assert.equal(calls.chat, 1);
});

test("แปลใบนัดไม่สำเร็จ: AI ล้มหรือตัวเลขไม่ตรงต้นฉบับ → failed ใช้ต้นฉบับไทย ไม่เก็บ cache", async () => {
  state.tables.slip_translations = [];
  const a = addAppointment({ purpose_text: "ติดตามอาการ", instructions: "กินยา 2 เม็ด ก่อน 09:00", note: null, link_code: "TRF234" });
  calls.failNext = Object.assign(new Error("400 Unsupported parameter: 'max_tokens' is not supported with this model."), { status: 400 });
  const r1 = await store.translateSlip(a.id);
  assert.deepEqual(r1, { en: {}, failed: ["purpose", "instructions"], error: "OpenAI 400: Unsupported parameter: 'max_tokens' is not supported with this model." }, "ส่ง error จริงแบบสั้นให้หน้าพิมพ์");
  aiReplies.next = { items: { 1: "Follow-up", 2: "Take 3 tablets before 9 am" } };
  const r2 = await store.translateSlip(a.id);
  assert.deepEqual(r2, { en: { purpose: "Follow-up" }, failed: ["instructions"], error: "ตัวเลข/เวลาในคำแปลไม่ตรงต้นฉบับ" }, "เลข 2 และ 09:00 หาย ถือว่าแปลไม่สำเร็จ");
  assert.deepEqual(state.tables.slip_translations.map((t) => t.text_en), ["Follow-up"]);
});

test("หน้าพิมพ์ใบนัด: เปิดเป็น TH เสมอ เรียกแปลเฉพาะตอนกด EN กลับ TH ไม่เรียก API", () => {
  const src = readFileSync("src/app/(staff)/appointments/[id]/print/print-client.tsx", "utf8");
  assert.match(src, /useState<SlipLang>\("th"\)/);
  assert.doesNotMatch(src, /defaultLang|\/slip-lang|slip_lang/);
  // fetch แปลมีที่เดียวใน translate() และเรียกจาก pickLang("en") เท่านั้น
  assert.equal((src.match(/\/translate`, \{ method: "POST" \}/g) ?? []).length, 1);
  assert.match(src, /if \(next === "en" && en === null && !translating\) void translate\(\);/);
  assert.equal((src.match(/void translate\(\)/g) ?? []).length, 2, "กด EN ครั้งแรก + ปุ่มลองใหม่");
  assert.doesNotMatch(src, /useEffect\([^)]*translate/);
});

// ---------------------------------------------------------------------------
// โควตา LINE ใกล้หมด/หมด
// ---------------------------------------------------------------------------
const quotaLib = await import("../src/lib/line-quota.ts");
const lineLib = await import("../src/lib/channels/line.ts");
/** สถานะโควตาที่เพิ่งอ่านจาก LINE (ไม่เรียก /quota ระหว่างเทสต์) */
const setQuota = (used, limit = 300, extra = {}) => {
  const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date());
  state.tables.settings = state.tables.settings.filter((r) => r.key !== "line_quota_state");
  state.tables.settings.push({ key: "line_quota_state", value: { type: "limited", limit, used, month, checked_at: new Date().toISOString(), ...extra } });
};
beforeEach(() => { quotaLib.clearQuotaMemo(); lineLib.resetLineQuotaBackoff(); setQuota(0); });
const quotaFetch = () => {
  globalThis.fetch = async (url, init) => {
    outbound.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith("/message/push")) return new Response('{"message":"You have reached your monthly limit."}', { status: 429 });
    return new Response("{}", { status: 400 });
  };
};

test("โควตาหมดตอนเตือนนัด: ไม่ retry เข้ารายการต้องโทร เหตุผล โควตา LINE หมด", async () => {
  quotaFetch();
  const tomorrow = inDays(1);
  const now = Date.parse(`${today}T16:59:00+07:00`);
  const a = addAppointment({ appoint_date: tomorrow, confirm_sent_at: new Date(now - 5 * 24 * HOUR).toISOString() });
  const r = await store.runAppointmentReminders(now);
  assert.deepEqual(r, { sent: 0, failed: 1, skipped: 0 });
  assert.equal(appt(a.id).last_send_error, "ส่งไม่ได้-ต้องโทร: โควตา LINE หมด");
  assert.equal(rules.callQueue(state.tables.appointments, now).mustCall, 1);
  assert.equal(outbound.filter((o) => o.url.endsWith("/message/push")).length, 1, "ไม่ลองซ้ำ");
  assert.equal(state.tables.appointment_events.find((e) => e.kind === "send_failed").detail.reason, "quota");
  assert.equal((await quotaLib.lineQuotaState(Date.now(), false)).level, "out");
});

test("โควตาเหลือน้อยกว่า 10%: ลงนัดใหม่งด push บันทึกว่าข้าม ไม่เข้าต้องโทร แต่ยังตอบด้วย reply token ได้", async () => {
  setQuota(280);
  const r = await store.createAppointment({ hn: "HN001", patient_name: "สมชาย", appoint_date: inDays(3), time_mode: "slot", slot_id: "morning", conversation_id: "conv-line" }, "agent");
  assert.equal(r.delivery.sent, false);
  assert.equal(r.delivery.skipped, true);
  assert.match(r.delivery.error, /โควตา LINE เหลือน้อย/);
  assert.equal(linePosts().length, 0, "ไม่ push");
  assert.ok(!appt(r.appointment.id).last_send_error, "ไม่เข้ารายการต้องโทร");
  assert.equal(state.tables.appointment_events.find((e) => e.kind === "send_skipped").detail.reason, "quota_low");

  // คนไข้เพิ่งทัก (มี reply token) → ส่งด้วย reply ได้
  Object.assign(conv("conv-line"), { line_reply_token: "RT9", line_reply_token_at: new Date().toISOString() });
  const r2 = await store.createAppointment({ hn: "HN001", patient_name: "สมชาย", appoint_date: inDays(4), time_mode: "slot", slot_id: "morning", conversation_id: "conv-line" }, "agent");
  assert.equal(r2.delivery.sent, true);
  assert.deepEqual(linePosts().map((o) => o.url.split("/").pop()), ["reply"]);

  // เตือนก่อนวันนัดยังใช้โควตาได้
  outbound = [];
  const now = Date.parse(`${today}T16:59:00+07:00`);
  const due = addAppointment({ appoint_date: inDays(1), confirm_sent_at: new Date(now - 5 * 24 * HOUR).toISOString(), link_code: "QLW234" });
  await store.runAppointmentReminders(now);
  assert.ok(appt(due.id).reminder_sent_at);
  assert.equal(linePosts().filter((o) => o.url.endsWith("/push")).length, 1);
});

test("ปิด ส่งข้อความทันทีเมื่อลงนัด: ลงนัดไม่ push / มี reply token ส่งได้ / เปลี่ยนนัดยังส่ง", async () => {
  state.tables.settings.push({ key: "appointment_settings", value: { send_on_create: false } });
  assert.equal(rules.normalizeAppointmentSettings({}).send_on_create, true, "ค่าเริ่มต้นเปิด");
  const r = await store.createAppointment({ hn: "HN001", patient_name: "สมชาย", appoint_date: inDays(3), time_mode: "slot", slot_id: "morning", conversation_id: "conv-line" }, "agent");
  assert.equal(r.delivery.skipped, true);
  assert.match(r.delivery.error, /ปิด "ส่งข้อความทันทีเมื่อลงนัด"/);
  assert.equal(linePosts().length, 0);
  assert.equal(state.tables.appointment_events.find((e) => e.kind === "send_skipped").detail.reason, "send_on_create_off");
  Object.assign(conv("conv-line"), { line_reply_token: "RT7", line_reply_token_at: new Date().toISOString() });
  const r2 = await store.createAppointment({ hn: "HN001", patient_name: "สมชาย", appoint_date: inDays(4), time_mode: "slot", slot_id: "morning", conversation_id: "conv-line" }, "agent");
  assert.equal(r2.delivery.sent, true);
  outbound = [];
  const moved = await store.updateAppointment(r.appointment.id, { appoint_date: inDays(5) }, "agent");
  assert.equal(moved.delivery.sent, true, "เปลี่ยนนัดส่งตามปกติ");
});

test("ข้อความพนักงานส่งไม่ได้เพราะโควตาหมด: API ตอบ 429 ข้อความชัด หน้าแชทแสดงค้าง", async () => {
  quotaFetch();
  state.currentUser = { id: "agent", email: "a@test" };
  const sendRoute = await import("../src/app/api/conversations/[id]/send/route.ts");
  const res = await sendRoute.POST(new Request("https://app.test/x", { method: "POST", body: JSON.stringify({ text: "สวัสดีค่ะ" }) }), { params: Promise.resolve({ id: "conv-line" }) });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "ส่งไม่ได้: โควตา LINE เดือนนี้หมด");
  assert.equal(messagesOf("conv-line").filter((m) => m.direction === "out").length, 0, "ไม่บันทึกว่าส่งแล้ว");
  const src = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(src, /setSendError\(msg\)/);
  assert.match(src, /\{sendError && \(/);
});

// ---------------------------------------------------------------------------
// หน้านัดหมาย: แท็บทั้งหมดไม่กรองวันโดยปริยาย badge ตรงกับรายการ
// ---------------------------------------------------------------------------
test("แท็บทั้งหมด: ไม่กรองวันโดยปริยาย แสดงนัดที่ผ่านมาแล้ว (ยกเลิกซ่อน เว้นแต่ รวมยกเลิก) ใกล้ถึงก่อน badge ตรงกับรายการทุกตัวกรอง", async () => {
  const past = addAppointment({ appoint_date: inDays(-10), status: "attended", link_code: "LST001" });
  const noShow = addAppointment({ appoint_date: inDays(-3), status: "no_show", link_code: "LST002" });
  const cancelled = addAppointment({ appoint_date: inDays(-1), status: "cancelled", link_code: "LST003" });
  const todayA = addAppointment({ appoint_date: today, link_code: "LST004" });
  const tomorrowA = addAppointment({ appoint_date: inDays(1), link_code: "LST005", purpose_id: PURPOSE_BLOOD });
  const future = addAppointment({ appoint_date: inDays(30), link_code: "LST006", patient_name: "มานี มีนา" });
  addAppointment({ appoint_date: inDays(-20), status: "attended", series_done: true, link_code: "LST007" });

  const all = await store.listAppointments({ tab: "all" });
  assert.deepEqual(all.map((a) => a.id), [todayA.id, tomorrowA.id, future.id, noShow.id, past.id], "ใกล้ถึงก่อน (วันนี้→ไกล) แล้วนัดที่ผ่านแล้วล่าสุด→เก่า รวมผ่านมาแล้ว ไม่รวมเข็มที่ฉีดแล้ว ไม่รวมยกเลิก");
  const withCancelled = await store.listAppointments({ tab: "all", includeCancelled: true });
  assert.deepEqual(withCancelled.map((a) => a.id), [todayA.id, tomorrowA.id, future.id, cancelled.id, noShow.id, past.id], "รวมยกเลิก");
  assert.deepEqual((await store.listAppointments({ tab: "all", status: "cancelled" })).map((a) => a.id), [cancelled.id], "กรองสถานะยกเลิก");
  const cases = [
    {},
    { includeCancelled: true },
    { status: "attended" },
    { status: "cancelled" },
    { from: inDays(-5), to: today },
    { q: "มานี" },
    { purpose: PURPOSE_BLOOD },
    { purpose: "none" },
  ];
  for (const f of cases) {
    const counts = await store.appointmentTabCounts(f);
    for (const tab of ["today", "tomorrow", "all"]) {
      const rows = await store.listAppointments({ tab, ...f });
      assert.equal(counts[tab], rows.length, `badge ${tab} ตรงกับรายการ ${JSON.stringify(f)}`);
    }
  }
  assert.equal((await store.appointmentTabCounts({ status: "attended" })).all, 1);

  // API: ส่งตัวกรองชุดเดียวกัน คืน badge ทุกแท็บ
  const res = await appointmentsRoute.GET(new Request(`https://app.test/api/appointments?tab=all&status=no_show`));
  const j = await res.json();
  assert.deepEqual(j.rows.map((r) => r.id), [noShow.id]);
  assert.equal(j.tabCounts.all, 1);
});

test("หน้านัดหมาย: ช่องตั้งแต่ว่างโดยปริยาย และมีปุ่มล้างตัวกรองเมื่อผลว่าง", () => {
  const src = readFileSync("src/app/(staff)/appointments/appointments-client.tsx", "utf8");
  assert.match(src, /const \[from, setFrom\] = useState\(""\)/);
  assert.match(src, /ไม่พบนัดตามเงื่อนไข · <button type="button" className="link-btn" onClick=\{clearFilters\}>ล้างตัวกรอง<\/button>/);
  assert.match(src, /const clearFilters = \(\) => \{ setPurpose\(""\); setQ\(""\); setFrom\(""\); setTo\(""\); setStatus\(""\); setWithCancelled\(false\); \};/);
  assert.match(src, /> รวมยกเลิก/);
  assert.match(src, /if \(withCancelled\) p\.set\("include_cancelled", "1"\);/);
});

test("รายการนัด embed แชทผ่าน FK ของ appointments.conversation_id (มี appointment_recipients แล้วต้องระบุ)", () => {
  const src = readFileSync("src/lib/appointment-store.ts", "utf8");
  assert.match(src, /conversations!appointments_conversation_id_fkey\(channels\(type\)/);
  assert.doesNotMatch(src.replace(/conversations!appointments_conversation_id_fkey\(/g, ""), /from\("appointments"\)\s*\n?\s*\.select\([^)]*conversations\(/);
});

test("กล่องขวาของแชท: นัดที่ยังไม่ถึงเรียงใกล้สุดก่อน นัดที่ผ่านแล้ว/ปิดแล้วแยกไว้ใน past (ใหม่สุดก่อน) · นัดที่ยกเลิกไม่แสดง", async () => {
  const route = await import("../src/app/api/conversations/[id]/appointments/route.ts");
  state.currentUser = { id: "agent", email: "a@test" };
  const far = addAppointment({ appoint_date: inDays(40), link_code: "SID001" });
  const near = addAppointment({ appoint_date: inDays(2), link_code: "SID002" });
  const cancelledFuture = addAppointment({ appoint_date: inDays(5), status: "cancelled", link_code: "SID003" });
  const attended = addAppointment({ appoint_date: inDays(-7), status: "attended", link_code: "SID004" });
  const older = addAppointment({ appoint_date: inDays(-30), status: "no_show", link_code: "SID005" });
  const j = await (await route.GET(new Request("https://app.test/x"), { params: Promise.resolve({ id: "conv-line" }) })).json();
  assert.deepEqual(j.groups[0].upcoming.map((a) => a.id), [near.id, far.id]);
  assert.deepEqual(j.groups[0].past.map((a) => a.id), [attended.id, older.id]);
  assert.ok(!JSON.stringify(j).includes(cancelledFuture.id), "นัดที่ยกเลิกซ่อนจากกล่องขวาทันที");
});

test("ส่วนนัดครั้งต่อไป: หัวข้อไม่ตัดบรรทัด ปุ่ม + มี tooltip ยกเลิกผูกเป็นลิงก์พร้อมยืนยัน บัญชีบรรทัดเดียว", () => {
  const src = readFileSync("src/app/(staff)/inbox/appointments-side-view.tsx", "utf8");
  assert.match(src, /<h3 className="appt-side-title">นัดครั้งต่อไป<\/h3>/);
  assert.match(src, /title="ทำนัดใหม่"/);
  assert.match(src, /className="link-btn danger-link" onClick=\{\(\) => setAsk\(/);
  assert.match(src, />รายละเอียด<\/button>/);
  assert.doesNotMatch(src, /รายละเอียด · แก้ไข\/ยกเลิก/);
  assert.match(src, /ดูนัดที่ผ่านมา \(\{g\.past\.length\}\)/);
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.appt-side-title \{[^}]*white-space: nowrap; min-width: max-content;/);
  assert.match(css, /\.appt-side-acc-name \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
});

// ---------------------------------------------------------------------------
// ตรวจการผูกบัญชีญาติ (a–d)
// ---------------------------------------------------------------------------
test("ผูกบัญชีญาติ a) สแกนรหัสซ้ำจากบัญชีที่ผูก HN นั้นอยู่แล้ว: ไม่สร้างแถวซ้ำ ตอบ ผูกไว้แล้ว ไม่ส่งการ์ดซ้ำ", async () => {
  linkPatientLine();
  const a = addAppointment({ link_code: "DUP234" });
  await lineWebhook.POST(lineRequest([lineText("ยืนยันนัด #DUP234", "m-dup-1")]));
  assert.equal(state.tables.patient_links.length, 1, "ไม่มีแถวผูกซ้ำ");
  const replies = linePosts();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].body.messages[0].type, "text");
  assert.match(replies[0].body.messages[0].text, /ผูกกับนัดนี้ไว้แล้ว/);
  assert.equal(state.tables.appointment_events.find((e) => e.kind === "linked").detail.already, true);
  assert.equal(appt(a.id).conversation_id, "conv-line");
});

test("ผูกบัญชีญาติ b,c) บัญชีใหม่เพิ่มเป็นบัญชีที่สอง ชื่อแชท (ญาติ) บัญชีคนไข้เดิมไม่ถูกแก้", async () => {
  linkPatientLine();
  const before = { ...contact("c-line") };
  const beforeLink = { ...state.tables.patient_links[0] };
  his.HN001 = { name: "สมชาย ใจดี", phone: "0812345678" };
  addAppointment({ link_code: "REL555" });
  await lineWebhook.POST(lineRequest([relativeText("ยืนยันนัด #REL555", "m-rel-b")]));
  const rel = relativeConv();
  assert.equal(state.tables.patient_links.length, 2);
  assert.equal(state.tables.patient_links.find((l) => l.conversation_id === rel.id).role, "relative");
  const relContact = state.tables.contacts.find((c) => c.external_id === RELATIVE);
  assert.equal(names.contactName(relContact), "สมชาย ใจดี · HN HN001 (ญาติ)");
  // c) บัญชีคนไข้เดิม
  for (const k of ["hn", "patient_full_name", "name_source", "patient_relation", "display_name"]) assert.equal(contact("c-line")[k], before[k], `contacts.${k} ไม่เปลี่ยน`);
  const after = state.tables.patient_links.find((l) => l.conversation_id === "conv-line");
  assert.equal(after.role ?? "patient", beforeLink.role ?? "patient");
  assert.equal(names.contactName(contact("c-line")), "สมชาย ใจดี · HN HN001");
});

test("ผูกบัญชีญาติ d) บัญชีญาติมีชื่อที่เจ้าหน้าที่ตั้งไว้: ไม่เขียนทับชื่อ", async () => {
  linkPatientLine();
  state.tables.contacts.push({ id: "c-rel", channel_id: "line", external_id: RELATIVE, display_name: "ลูกสาวคุณสมชาย", name_locked: true, name_source: "staff", language: "th" });
  state.tables.conversations.push({ id: "conv-rel", contact_id: "c-rel", channel_id: "line", status: "closed", tags: [], unread_count: 0, open_tasks: 0, sensitive: false, archived: false });
  his.HN001 = { name: "สมชาย ใจดี", phone: "0812345678" };
  addAppointment({ link_code: "REL666" });
  await lineWebhook.POST(lineRequest([relativeText("ยืนยันนัด #REL666", "m-rel-d")]));
  const c = contact("c-rel");
  assert.equal(c.display_name, "ลูกสาวคุณสมชาย");
  assert.equal(c.name_source, "staff");
  assert.equal(names.contactName(c), "ลูกสาวคุณสมชาย");
  assert.equal(state.tables.patient_links.find((l) => l.conversation_id === "conv-rel").role, "relative");
});

// ---------------------------------------------------------------------------
// บัญชีเดียวผูกหลาย HN
// ---------------------------------------------------------------------------
test("บัญชี A สแกนใบของ HN1 แล้วใบของ HN2: ชื่อแชท บทบาท กลุ่มในกล่องขวา และข้อความเตือนระบุชื่อคนที่นัด", async () => {
  his.HN1 = { name: "สมชาย ใจดี", phone: "0811111111" };
  his.HN2 = { name: "มานี ใจดี", phone: "0822222222" };
  const now = Date.parse(`${today}T16:59:00+07:00`);
  const old = new Date(now - 5 * 24 * HOUR).toISOString();
  const a1 = addAppointment({ hn: "HN1", patient_name: "สมชาย ใจดี", conversation_id: null, link_code: "HNA111", appoint_date: inDays(1) });
  const a2 = addAppointment({ hn: "HN2", patient_name: "มานี ใจดี", conversation_id: null, link_code: "HNB222", appoint_date: inDays(1), purpose_text: "ฉีดวัคซีน" });

  await lineWebhook.POST(lineRequest([lineText("ยืนยันนัด #HNA111", "m-a1")]));
  assert.deepEqual(state.tables.patient_links.map((l) => [l.hn, l.role]), [["HN1", "patient"]]);
  assert.equal(names.contactName(contact("c-line")), "สมชาย ใจดี · HN HN1");
  // ผูก HN เดียว: ข้อความเดิม ไม่มี "นัดของ"
  assert.doesNotMatch(linePosts()[0].body.messages[0].altText, /นัดของ/);

  outbound = [];
  await lineWebhook.POST(lineRequest([lineText("ยืนยันนัด #HNB222", "m-a2")]));
  assert.deepEqual(state.tables.patient_links.map((l) => [l.hn, l.role]).sort(), [["HN1", "patient"], ["HN2", "relative"]]);
  assert.equal(contact("c-line").hn, "HN1", "HN หลัก = HN ที่เป็นคนไข้เอง");
  assert.equal(names.contactName(contact("c-line")), "สมชาย ใจดี · HN HN1");
  assert.equal(appt(a2.id).conversation_id, "conv-line");
  assert.match(linePosts()[0].body.messages[0].altText, /นัดของ มานี ใจดี/, "การ์ดของ HN2 ระบุชื่อ");

  // กล่องขวา: แยกกลุ่ม HN1 (ของตัวเอง หลัก) / HN2 (ญาติ)
  state.currentUser = { id: "agent", email: "a@test" };
  const route = await import("../src/app/api/conversations/[id]/appointments/route.ts");
  const j = await (await route.GET(new Request("https://app.test/x"), { params: Promise.resolve({ id: "conv-line" }) })).json();
  assert.deepEqual(j.groups.map((g) => [g.hn, g.name, g.role, g.primary, g.upcoming.map((x) => x.id)]), [
    ["HN1", "สมชาย ใจดี", "patient", true, [a1.id]],
    ["HN2", "มานี ใจดี", "relative", false, [a2.id]],
  ]);

  // เตือนก่อนวันนัด: บัญชีผูก 2 HN → ทุกข้อความระบุชื่อคนที่นัด
  outbound = [];
  Object.assign(appt(a1.id), { confirm_sent_at: old });
  Object.assign(appt(a2.id), { confirm_sent_at: old });
  await store.runAppointmentReminders(now);
  const alts = linePosts().filter((o) => o.url.endsWith("/push")).map((o) => o.body.messages[0].altText);
  assert.equal(alts.length, 2);
  assert.ok(alts.some((t) => /นัดของ สมชาย ใจดี/.test(t)));
  assert.ok(alts.some((t) => /นัดของ มานี ใจดี/.test(t)));
  // ปุ่มยืนยันผูกกับนัดนั้นๆ
  const datas = linePosts().filter((o) => o.url.endsWith("/push")).map((o) => o.body.messages[0].contents.footer.contents[0].action.data).sort();
  assert.deepEqual(datas, [`appt:confirm:${a1.id}`, `appt:confirm:${a2.id}`].sort());

  // ยกเลิกผูกเฉพาะ HN2: HN1 ไม่กระทบ
  state.currentUser = { id: "adm", email: "adm@test" };
  const del = await patientLinkRoute.DELETE(new Request("https://app.test/x?hn=HN2", { method: "DELETE" }), { params: Promise.resolve({ id: "conv-line" }) });
  assert.equal(del.status, 200);
  assert.deepEqual(state.tables.patient_links.map((l) => l.hn), ["HN1"]);
  assert.equal(names.contactName(contact("c-line")), "สมชาย ใจดี · HN HN1");
});

test("บัญชีญาติล้วน (ไม่มี HN ที่เป็นคนไข้เอง): ชื่อแชท = ชื่อ HN ล่าสุด (ญาติ) / แอดมินเปลี่ยนบทบาทและ HN หลักได้", async () => {
  his.HN1 = { name: "สมชาย ใจดี" };
  his.HN2 = { name: "มานี ใจดี" };
  // HN1 และ HN2 มีบัญชีคนไข้อยู่แล้ว
  state.tables.patient_links.push({ conversation_id: "conv-fb", hn: "HN1", role: "patient", linked_at: nextTime() }, { conversation_id: "conv-fb", hn: "HN2", role: "patient", linked_at: nextTime() });
  const linkStore = await import("../src/lib/patient-link-store.ts");
  await linkStore.linkConversationToHn("conv-line", "HN1", { via: "staff", staffId: "adm" });
  await linkStore.linkConversationToHn("conv-line", "HN2", { via: "staff", staffId: "adm" });
  assert.deepEqual(state.tables.patient_links.filter((l) => l.conversation_id === "conv-line").map((l) => l.role), ["relative", "relative"]);
  assert.equal(names.contactName(contact("c-line")), "มานี ใจดี · HN HN2 (ญาติ)");
  // แอดมินตั้ง HN1 เป็นคนไข้ → ชื่อแชทเป็น HN1
  await linkStore.setPatientRelation("conv-line", "patient", "HN1");
  assert.equal(names.contactName(contact("c-line")), "สมชาย ใจดี · HN HN1");
  // ผูกซ้ำ HN เดิม: ไม่สร้างแถวใหม่
  const again = await linkStore.linkConversationToHn("conv-line", "HN1", { via: "link_code", staffId: null });
  assert.equal(again.alreadyLinked, true);
  assert.equal(state.tables.patient_links.filter((l) => l.conversation_id === "conv-line").length, 2);
});

// ---------------------------------------------------------------------------
// เวลา ":" ทุกที่ + เบอร์มือถือ
// ---------------------------------------------------------------------------
const timeLib = await import("../src/lib/time-format.ts");

test("formatTime ทุกค่า 00:00–23:59 เป็น HH:mm และ clock รับหลายรูปแบบ", () => {
  for (let h = 0; h < 24; h++) for (let m = 0; m < 60; m++) {
    assert.match(timeLib.formatTime(h, m), /^\d{2}:\d{2}$/);
    assert.equal(timeLib.formatTime(h, m), `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  assert.equal(timeLib.clock("8:00"), "08:00");
  assert.equal(timeLib.clock("08:00:00"), "08:00");
  assert.equal(timeLib.clock("08.30"), "08:30");
  assert.equal(timeLib.timeRange("08:00:00", "12:00:00"), "08:00–12:00");
  assert.equal(timeLib.thaiDateTime("2026-11-09T07:30:00Z"), "9 พ.ย. 14:30");
  assert.equal(timeLib.bangkokClock("2026-11-09T17:05:00Z"), "00:05");
});

test("ข้อความ LINE/FB และใบนัดไม่มีเวลาแบบจุด (08.00) ใช้ เวลา ... น. และ Time ...", () => {
  const dotted = /\d{2}\.\d{2}/;
  const base = { id: "a1", patient_name: "สมชาย", appoint_date: "2026-11-23", time_mode: "slot", time_start: "08:00:00", time_end: "12:00:00", purpose_text: "เจาะเลือด", instructions: "งดอาหาร" };
  const exact = { ...base, time_mode: "exact", time_start: "14:30:00", time_end: null };
  const settings = rules.normalizeAppointmentSettings({ clinic_mobile: "081-234-5678" });
  const series = [{ label: "เข็ม 1", appoint_date: "2026-11-09", time_mode: "slot", time_start: "08:00", time_end: "12:00", done: true }, { label: "เข็ม 2", appoint_date: "2026-12-09", time_mode: "slot", time_start: "13:00", time_end: "18:00" }];
  for (const lang of ["th", "en"]) for (const kind of ["new", "reminder", "changed", "cancelled"]) for (const a of [base, exact]) {
    const input = { kind, lang, appointment: a, settings, clinicName: "คลินิก", includePurpose: true, previous: { appoint_date: "2026-11-20", time_mode: "exact", time_start: "09:30", time_end: null }, series, forPatient: "มานี" };
    const text = rules.appointmentText(input);
    const flex = JSON.stringify(rules.appointmentFlex(input));
    assert.doesNotMatch(text, dotted, `${lang} ${kind}`);
    assert.doesNotMatch(flex, dotted, `flex ${lang} ${kind}`);
    assert.doesNotMatch(text, /มาได้ช่วง/);
    assert.match(text, /081-234-5678/, "เบอร์มือถือในทุกข้อความ");
  }
  const th = rules.appointmentText({ kind: "new", lang: "th", appointment: base, settings, clinicName: "คลินิก", includePurpose: false });
  assert.match(th, /เวลา 08:00–12:00 น\. \(ตรวจตามลำดับคิว\)/);
  // บรรทัดติดต่อเดียวมีทั้งเบอร์คลินิกและมือถือ
  assert.match(th, /สอบถามโทร 02-000-4586, 081-234-5678/);
  assert.doesNotMatch(th, /·\s*$|โทร\s+·/m);
  const en = rules.appointmentText({ kind: "new", lang: "en", appointment: base, settings, clinicName: "Clinic", includePurpose: false });
  assert.match(en, /Time 08:00–12:00 \(Seen in queue order\)/);
  assert.match(rules.appointmentText({ kind: "new", lang: "th", appointment: exact, settings, clinicName: "คลินิก", includePurpose: false }), /เวลา 14:30 น\./);
  for (const lang of ["th", "en"]) {
    const v = slipLib.slipView(slipBase({ series: [] }), lang);
    assert.doesNotMatch(JSON.stringify(v), dotted, `slip ${lang}`);
  }
});

test("เบอร์มือถือคลินิก: ว่าง = ไม่มีบรรทัด / ตั้งแล้วแสดงในข้อความ ใบนัด TH/EN / {mobile} ใน template", () => {
  const base = { id: "a1", patient_name: "สมชาย", appoint_date: "2026-11-23", time_mode: "exact", time_start: "10:00", time_end: null, purpose_text: null, instructions: null };
  const empty = rules.normalizeAppointmentSettings({});
  assert.equal(empty.clinic_mobile, "");
  const t0 = rules.appointmentText({ kind: "new", lang: "th", appointment: base, settings: empty, clinicName: "คลินิก", includePurpose: false });
  assert.doesNotMatch(t0, /มือถือ/);
  const custom = rules.normalizeAppointmentSettings({ clinic_mobile: "089-999-0000", template_th: "เรียน {name}\n{date}\nมือถือ {mobile}" });
  assert.match(rules.appointmentText({ kind: "new", lang: "th", appointment: base, settings: custom, clinicName: "คลินิก", includePurpose: false }), /\nมือถือ 089-999-0000/);
  const noMobile = rules.normalizeAppointmentSettings({ template_th: "เรียน {name}\nมือถือ {mobile}\nจบ" });
  assert.equal(rules.appointmentText({ kind: "new", lang: "th", appointment: base, settings: noMobile, clinicName: "คลินิก", includePurpose: false }).includes("มือถือ"), false, "ว่างแล้วบรรทัด {mobile} หาย");
  const withM = slipBase({ clinic: { ...slipBase().clinic, mobile: "089-999-0000" } });
  // ใบนัด: ไม่มีคำว่า "มือถือ" หน้าเบอร์ — เบอร์ต่อกันหลัง "โทร" คำเดียว
  assert.equal(slipLib.slipView(withM, "th").clinicPhone, "โทร 02-000-4586 · 089-999-0000");
  assert.equal(slipLib.slipView(withM, "en").clinicPhone, "Tel 02-000-4586 · 089-999-0000");
  assert.equal(slipLib.slipView(slipBase(), "th").clinicPhone, "โทร 02-000-4586");
  const onlyM = slipBase({ clinic: { ...slipBase().clinic, phone: "", mobile: "089-999-0000" } });
  assert.equal(slipLib.slipView(onlyM, "th").clinicPhone, "โทร 089-999-0000");
  assert.ok(rules.TEMPLATE_VARIABLES.includes("{mobile}"));
});

test("หน้าเว็บไม่ใช้ th-TH แสดงเวลา (ได้ 08.00) ใช้ helper กลาง", () => {
  for (const f of ["src/app/(staff)/appointments/appointment-drawer.tsx", "src/app/(staff)/inbox/inbox-client.tsx", "src/app/(staff)/inbox/team-panel.tsx",
    "src/app/(staff)/knowledge/knowledge-client.tsx", "src/app/(staff)/settings/health-panel.tsx", "src/app/(staff)/settings/price-alerts.tsx", "src/app/(staff)/appointments/new-appointment.tsx"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /toLocale(Time)?String\("th-TH", \{[^}]*hour/, f);
  }
});

test("หน้าตั้งค่ามาตรฐาน: เมนูหมวดซ้าย ?section= กลุ่ม+แถว ไม่มีการ์ด/masonry/ส่วนพับ บันทึกรวมปุ่มเดียว", () => {
  const dir = "src/app/(staff)/settings/";
  const read = (f) => readFileSync(dir + f, "utf8");
  const files = ["settings-client.tsx", "appointment-settings.tsx", "appointment-presets.tsx", "series-templates.tsx", "health-panel.tsx", "line-usage-panel.tsx", "ai-models-panel.tsx", "price-alerts.tsx", "tag-settings.tsx"];
  for (const f of files) {
    const src = read(f);
    // ไม่มีกรอบการ์ด ไม่มี masonry ไม่มีส่วนพับ ไม่มีอีโมจิในหัวข้อ
    assert.doesNotMatch(src, /className="card[ "]/, f);
    assert.doesNotMatch(src, /settings-masonry|CardHead/, f);
    assert.doesNotMatch(src, /<details|<summary/, f);
    assert.doesNotMatch(src, /title="[^"]*[💬🤖🔒📅⚠]/u, f);
    // ไม่มีปุ่มบันทึกย่อย
    assert.doesNotMatch(src, />บันทึก(เวลาเปิด| template|โมเดล)?</, f);
    assert.doesNotMatch(src, /className="set-save"|ปุ่มนี้บันทึกทุกการ์ดยกเว้น/, f);
  }
  const page = read("settings-client.tsx");
  for (const t of ["ภาพรวม", "AI", "แชทและแท็ก", "นัดหมาย", "ทีมและระบบ"]) assert.ok(page.includes(`"${t}"`), t);
  assert.match(page, /searchParams\.set\("section", t\)/);
  assert.match(page, /get\("section"\)/);
  assert.match(page, /tab-dot red/);
  assert.match(page, /tab-dot yellow/);
  assert.match(page, /beforeunload/);
  assert.match(page, /มีการแก้ไขที่ยังไม่บันทึก \(\{dirtySections\.length\} หมวด/);
  assert.match(page, /className="settings-nav"/);
  const body = page.slice(page.indexOf("<SettingsContext.Provider"));
  const order = (...names) => { let at = 0; return names.every((n) => { const i = body.indexOf(n, at); if (i < 0) return false; at = i; return true; }); };
  assert.ok(order('panel("overview"', "<HealthPanel", "<LineUsagePanel", "การใช้ AI", 'panel("ai"', "<AiModelsPanel", "โหมด AI ทั้งระบบ", "รายช่องทาง", "บุคลิกการตอบ",
    'panel("chat"', "เวลาทำการ", "ย้ายไปเสร็จแล้วอัตโนมัติ", "<TagSettings", "แชทลับ", 'panel("appointments"', "<AppointmentSettings", "ข้อความการจอง",
    'panel("team"', "เกณฑ์คะแนน", "การเก็บรูปภาพ"), "กลุ่มอยู่ในหมวดตามสเปก");
  assert.match(page, /set-other-note[^]*เวลาเปิดคลินิก/);

  const appt = read("appointment-settings.tsx");
  const apptOrder = (...names) => { let at = 0; return names.every((n) => { const i = appt.indexOf(n, at); if (i < 0) return false; at = i; return true; }); };
  assert.ok(apptOrder('title="การติดต่อ"', "เวลาส่งเตือน", "เบอร์คลินิก", "เบอร์มือถือคลินิก", "LINE OA ID", "ที่อยู่คลินิก (ไทย)", "ชื่อคลินิกภาษาอังกฤษ", "ที่อยู่ภาษาอังกฤษ",
    'title="การส่งข้อความ"', 'title="ข้อความนัด"', "<PurposePresets", "<ClinicHoursSettings", "<SeriesTemplates", "{children}"), "ลำดับกลุ่มนัดหมาย");
  assert.match(appt, /className="var-chip".*onClick=\{\(\) => insertVar\(v\)\}/);
  assert.match(appt, /className="tpl-pair"/);
  assert.match(appt, /ดูตัวอย่างข้อความ/);
  assert.match(appt, /ใช้ข้อความแนะนำ/);
  assert.match(appt, /template_th\.includes\("\{mobile\}"\) \? \{\} : \{ template_th: SUGGESTED_TEMPLATE_TH \}/);
  assert.match(appt, /useSaveUnit\("appointment-settings"/);
  for (const f of ["reminder_time", "clinic_phone", "clinic_mobile", "line_oa_id", "clinic_address", "clinic_name_en", "clinic_address_en", "send_purpose_in_message", "send_on_create", "template_th", "template_en"]) assert.match(appt, new RegExp(`s\\.${f}`), f);

  const presets = read("appointment-presets.tsx");
  assert.match(presets, /className={`slist-row preset-row/);
  assert.match(presets, /<table className="set-table hours-grid">/);
  assert.match(presets, /useSaveUnit\("purpose-presets"/);
  assert.match(presets, /useSaveUnit\("clinic-hours"/);
  assert.doesNotMatch(presets, /saveRow|onBlur/);
  assert.match(presets, /แยกตั้งรายวัน/);
  assert.match(presets, /title="วันหยุดพิเศษ"/);
  assert.match(presets, /แยกจาก “เวลาทำการ”/);
  assert.match(read("series-templates.tsx"), /useSaveUnit\("series-templates"/);

  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.settings-layout \{ display: grid; grid-template-columns: 220px minmax\(0, 1fr\);/);
  assert.match(css, /\.settings-nav \{ position: sticky;/);
  assert.match(css, /\.settings-page \.set-group2-head h2 \{ font-size: var\(--fs-card-title\); font-weight: 700;/);
  assert.match(css, /\.set-line \{ display: grid; grid-template-columns: minmax\(0, 35fr\) minmax\(0, 65fr\);/);
  assert.match(css, /@media \(max-width: 1023px\) \{\n  \.set-line \{ grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.settings-savebar \{ position: sticky; bottom: 0;[^}]*background: var\(--card\); border-top: 1px solid var\(--line\);/);
  assert.doesNotMatch(css, /settings-masonry|backdrop-filter: blur\(6px\)/);
  assert.match(css, /\.set-table td, \.set-table tbody th \{ height: 46px;/);
  for (const v of ["--fs-page-title: 20px", "--fs-card-title: 16px", "--fs-group: 15px", "--fs-label: 14px", "--fs-body: 14px", "--fs-help: 13px", "--fs-badge: 12px", "--field-h: 38px", "--field-px: 12px", "--gap-label: 4px", "--gap-field: 12px", "--gap-group: 20px", "--check-size: 18px"]) assert.ok(css.includes(v), v);
  const scoped = css.split(/\r?\n/).filter((l) => /^\.(set-|health-|line-usage|ai-models|var-chip|info-tip|tiny-note|settings-|preset-table|hours-grid)/.test(l.trim()));
  assert.deepEqual(scoped.filter((l) => /font-size: [\d.]+px/.test(l) && !/^\.settings-page \.set-group2-head h2/.test(l.trim())), []);
});

test("เวลาเปิดคลินิกแบบยุบแถว: จันทร์–ศุกร์เท่ากัน = 3 แถว แก้แถวกลุ่มเขียนทุกวัน ไม่เท่ากัน = ต้องแสดงรายวัน", async () => {
  const g = await import("../src/lib/clinic-hours-group.ts");
  const day = (d, id, s, e) => ({ weekday: d, slot_id: id, label: id === "morning" ? "ช่วงเช้า" : "ช่วงบ่าย", start_time: s, end_time: e, sort_order: 10 });
  const week = [1, 2, 3, 4, 5].flatMap((d) => [day(d, "morning", "08:00", "12:00"), day(d, "afternoon", "13:00", "18:00")]).concat([day(6, "morning", "08:00", "12:00")]);
  assert.equal(g.weekdaysUniform(week), true);
  assert.deepEqual(g.HOUR_GROUPS.map((x) => x.label), ["จันทร์–ศุกร์", "เสาร์", "อาทิตย์"]);
  assert.deepEqual(g.DAY_ORDER, [1, 2, 3, 4, 5, 6, 0]);
  // แก้แถวจันทร์–ศุกร์ → ทุกวันในกลุ่มเปลี่ยน เสาร์ไม่เปลี่ยน ฐานข้อมูลยังรายวัน
  const edited = g.patchGroupSlot(week, [1, 2, 3, 4, 5], "morning", { start_time: "09:00" });
  assert.deepEqual([1, 2, 3, 4, 5].map((d) => g.slotsOfDay(edited, d)[0].start_time), ["09:00", "09:00", "09:00", "09:00", "09:00"]);
  assert.equal(g.slotsOfDay(edited, 6)[0].start_time, "08:00");
  assert.equal(edited.length, week.length);
  assert.notEqual(g.hoursSignature(edited), g.hoursSignature(week));
  // ลำดับในอาร์เรย์ไม่ทำให้เป็น "แก้แล้ว"
  assert.equal(g.hoursSignature([...week].reverse()), g.hoursSignature(week));
  // เพิ่ม/ลบช่วงในกลุ่ม
  const added = g.addGroupSlot(week, [6]);
  assert.deepEqual(g.slotsOfDay(added, 6).map((s) => s.slot_id), ["morning", "afternoon"]);
  assert.equal(g.removeGroupSlot(week, [1, 2, 3, 4, 5], "afternoon").filter((s) => s.slot_id === "afternoon").length, 0);
  // พุธต่างจากวันอื่น → ไม่ยุบ (ห้ามทับค่า)
  const odd = g.patchGroupSlot(week, [3], "afternoon", { end_time: "16:00" });
  assert.equal(g.weekdaysUniform(odd), false);
  assert.equal(g.weekdaysUniform([]), true);
  assert.match(g.validateHours([day(1, "morning", "12:00", "08:00")]), /จันทร์: ช่วงเวลาไม่ถูกต้อง/);
  assert.match(g.validateHours([day(1, "morning", "08:00", "12:00"), day(1, "morning", "13:00", "14:00")]), /ซ้ำ/);
  assert.equal(g.validateHours(week), null);
});

test("ข้อความนัด: บรรทัดติดต่อมีทั้งโทรและมือถือ ไม่มีมือถือ/ไม่มีเบอร์คลินิก ตัดเฉพาะส่วนนั้น (TH/EN)", () => {
  const f = rules.fillVariables;
  assert.equal(f("สอบถามโทร {phone}, {mobile}", { phone: "02-111", mobile: "081-2" }), "สอบถามโทร 02-111, 081-2");
  assert.equal(f("สอบถามโทร {phone}, {mobile}", { phone: "02-111", mobile: "" }), "สอบถามโทร 02-111");
  assert.equal(f("Questions? Call {phone}, {mobile}", { phone: "02-111", mobile: "" }), "Questions? Call 02-111");
  assert.equal(f("สอบถามโทร {phone}, {mobile}", { phone: "", mobile: "081-2" }), "สอบถามโทร 081-2");
  assert.equal(f("Questions? Call {phone}, {mobile}", { phone: "", mobile: "081-2" }), "Questions? Call 081-2");
  // แบบเก่า " · มือถือ {mobile}" ยังตัดได้
  assert.equal(f("สอบถามโทร {phone} · มือถือ {mobile}", { phone: "02-111", mobile: "" }), "สอบถามโทร 02-111");
  // template เก่าที่ไม่มี {mobile}: ต่อเบอร์มือถือหลังเบอร์คลินิกในบรรทัดเดียวกัน ไม่มีคำว่า "โทร/มือถือ"
  assert.equal(f("สอบถามโทร {phone}", { phone: "02-111", mobile: "081-2", mobileLabel: "โทร" }), "สอบถามโทร 02-111, 081-2");
  assert.equal(f("เรียน {name}", { name: "ก", phone: "02-111", mobile: "081-2", mobileLabel: "โทร" }), "เรียน ก\nโทร 081-2");
  assert.ok(rules.SUGGESTED_TEMPLATE_TH.includes("สอบถามโทร {phone}, {mobile}"));
  assert.ok(rules.SUGGESTED_TEMPLATE_EN.includes("Call {phone}, {mobile}"));
  assert.equal(rules.DEFAULT_APPOINTMENT_SETTINGS.template_th, rules.SUGGESTED_TEMPLATE_TH);
  // ค่าที่ admin แก้เองไม่ถูกเปลี่ยนตอน normalize
  assert.equal(rules.normalizeAppointmentSettings({ template_th: "ข้อความเอง {name}" }).template_th, "ข้อความเอง {name}");
});


test("รายการแถวกะทัดรัด: แท็กเป็นชิปจริง คลิกจุดเปลี่ยนสี ลาก ⋮⋮ + ↑/↓ สวิตช์ไม่มีข้อความ เมนู ⋯ เพิ่มท้ายกลุ่ม · ใช้กับเหตุผลนัดและกฎ", () => {
  const dir = "src/app/(staff)/settings/";
  const list = readFileSync(dir + "settings-list.tsx", "utf8");
  assert.match(list, /e\.key === "ArrowUp" \? i - 1 : e\.key === "ArrowDown" \? i \+ 1/);
  assert.match(list, /draggable: true/);
  assert.match(list, /aria-live|announce/);
  assert.doesNotMatch(list, /window\.confirm\(|[^.\w]confirm\(/, "ยืนยันในเมนู ไม่ใช้ dialog ของเบราว์เซอร์");
  const tags = readFileSync(dir + "tag-settings.tsx", "utf8");
  assert.match(tags, /className="tag-chip settings-tag-chip"/);
  assert.match(tags, /<input type="color" className="sr-only"/);
  assert.match(tags, /<DragHandle/);
  assert.doesNotMatch(tags, /aria-label=\{`เลื่อน .* (ขึ้น|ลง)`\}/, "ไม่มีปุ่มลูกศรขึ้น/ลง");
  assert.match(tags, /<Switch checked=\{t\.active\} hideLabel/);
  assert.match(tags, /columns=\{<span>เปิดใช้<\/span>\}/, "หัวคอลัมน์บอกครั้งเดียว");
  assert.doesNotMatch(tags, /> เปิดใช้</);
  assert.match(tags, /\+ เพิ่มแท็ก/);
  assert.match(tags, /\+ เพิ่มกฎ/);
  assert.match(tags, /<RowMenu/);
  assert.doesNotMatch(tags, /SetLine/, "หัวกลุ่มอยู่เหนือรายการ ไม่ใช้คอลัมน์ซ้าย 35%");
  // ลบแท็กได้เฉพาะที่ยังไม่มีแชท/กฎใช้ (แชทเก็บแท็กเป็นชื่อ)
  assert.match(tags, /contains\("tags", \[t\.name\]\)/);
  const presets = readFileSync(dir + "appointment-presets.tsx", "utf8");
  assert.match(presets, /<DragHandle/);
  assert.match(presets, /\+ เพิ่มเหตุผลนัด/);
  assert.match(presets, /<Switch checked=\{r\.active\} hideLabel/);
  assert.doesNotMatch(presets, /preset-table/);
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.slist-group \{ max-width: 720px;/);
  assert.match(css, /\.slist-row \{ display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 4px 0; border-bottom: 1px solid var\(--line\); \}/);
  assert.match(css, /\.switch-track \{ position: relative; width: 36px; height: 20px;/);
  // แถบบันทึกอยู่ล่างจอทุกหมวด
  assert.match(css, /\.page\.settings-page \{ min-height: 100%; display: flex; flex-direction: column; \}/);
  assert.match(css, /\.page\.settings-page > \.settings-layout \{ flex: 1 0 auto;/);
});

test("ผู้นัด: ทำความสะอาดชื่อ รวมซ้ำ ซ่อนเกิน 180 วัน แพทย์ที่ตรวจวันนี้อยู่บนสุดแต่ไม่เลือกให้", async () => {
  const p = await import("../src/lib/providers.ts");
  assert.equal(p.cleanProviderName("  นพ.สมชาย   ใจดี \n"), "นพ.สมชาย ใจดี");
  assert.equal(p.cleanProviderName(null), "");
  const now = Date.parse("2026-11-10T05:00:00Z");
  const day = (n) => new Date(now - n * 86_400_000).toISOString();
  const list = [
    { name: "พญ.เก่ามาก", last_seen_at: day(200), active: null },
    { name: "พญ.เก่าแต่เปิดไว้", last_seen_at: day(400), active: true },
    { name: "นพ.ซ่อนเอง", last_seen_at: day(1), active: false },
    { name: "นพ.เมื่อวาน", last_seen_at: day(1), active: null },
    { name: "นพ.สัปดาห์ก่อน", last_seen_at: day(7), active: null },
  ];
  assert.equal(p.providerVisible(list[0], now), false, "ไม่พบเกิน 180 วันซ่อน");
  assert.equal(p.providerVisible(list[1], now), true, "แอดมินเปิดไว้แสดงเสมอ");
  assert.equal(p.providerVisible(list[2], now), false, "แอดมินปิดซ่อนเสมอ");
  const opts = p.providerOptions(list, ["นพ.สัปดาห์ก่อน"], null, now);
  assert.deepEqual(opts.map((o) => o.name), ["นพ.สัปดาห์ก่อน", "นพ.เมื่อวาน", "พญ.เก่าแต่เปิดไว้"]);
  assert.deepEqual(opts.map((o) => o.today), [true, false, false]);
  // ค่าเดิมของนัดที่ถูกซ่อนแล้วยังเลือกค้างไว้ได้
  assert.ok(p.providerOptions(list, [], "พญ.เก่ามาก", now).some((o) => o.name === "พญ.เก่ามาก"));
  // ค้นไม่สนคำนำหน้าและช่องว่าง
  assert.deepEqual(p.filterProviders(opts, "เมื่อ วาน").map((o) => o.name), ["นพ.เมื่อวาน"]);
  assert.equal(p.filterProviders(opts, "").length, 3);
});

test("ผู้นัด: ฟอร์มเริ่มว่าง (ไม่เติมหมอจาก visit) dropdown มี — ไม่ระบุ — และป้ายตรวจวันนี้", () => {
  const nw = readFileSync("src/app/(staff)/appointments/new-appointment.tsx", "utf8");
  assert.match(nw, /provider: "" \}\);/);
  assert.doesNotMatch(nw, /provider: tidy\(p\.doctor/);
  const form = readFileSync("src/app/(staff)/appointments/appointment-form.tsx", "utf8");
  assert.match(form, /<ProviderSelect value=\{form\.provider\}/);
  assert.doesNotMatch(form, /datalist id="appt-providers"/);
  const sel = readFileSync("src/app/(staff)/appointments/provider-select.tsx", "utf8");
  assert.match(sel, /\{ name: "", label: "— ไม่ระบุ —" \}/);
  assert.match(sel, /ตรวจวันนี้/);
  assert.match(sel, /role="listbox"/);
  const drawer = readFileSync("src/app/(staff)/appointments/appointment-drawer.tsx", "utf8");
  assert.match(drawer, /\{a\.provider && <><dt>ผู้นัด<\/dt><dd>\{a\.provider\}<\/dd><\/>\}/);
  assert.doesNotMatch(drawer, /a\.provider \|\| "–"/);
  const cache = readFileSync("supabase/functions/_shared/his-cache.ts", "utf8");
  assert.match(cache, /await touchProviders\(db, rows\.map\(\(r\) => r\.doctor_name\)\)/);
  assert.match(cache, /replace\(\/\\s\+\/g, " "\)/);
  const sql = readFileSync("supabase/migrations/053_providers.sql", "utf8");
  assert.match(sql, /create table if not exists providers/);
  assert.match(sql, /on conflict \(lower\(name\)\) do update set last_seen_at = greatest/);
  assert.match(sql, /grant execute on function touch_providers\(text\[\], timestamptz\) to service_role;/);
});

test("ผู้นัดว่าง: ใบนัด TH/EN และข้อความทุกแบบไม่มีบรรทัดผู้นัด/Doctor", () => {
  const noProvider = slipBase();
  noProvider.appointment = { ...noProvider.appointment, provider: null };
  for (const lang of ["th", "en"]) {
    const v = slipLib.slipView(noProvider, lang);
    assert.ok(!v.rows.some((r) => /ผู้นัด|Doctor/.test(r.label)), lang);
    assert.doesNotMatch(JSON.stringify(v), /ผู้นัด|"Doctor"|"–"/, lang);
    const withP = slipLib.slipView(slipBase(), lang);
    assert.ok(withP.rows.some((r) => r.label === (lang === "th" ? "ผู้นัด" : "Doctor") && r.value === "นพ.ทดสอบ"), `${lang} มีผู้นัดแสดง`);
  }
  const settings = rules.normalizeAppointmentSettings({});
  const appt = { id: "a1", patient_name: "สมชาย", appoint_date: "2026-11-23", time_mode: "slot", time_start: "08:00", time_end: "12:00", purpose_text: "เจาะเลือด", instructions: null, provider: null };
  for (const lang of ["th", "en"]) for (const kind of ["new", "reminder", "changed", "cancelled"]) {
    const input = { kind, lang, appointment: appt, settings, clinicName: "คลินิก", includePurpose: true, previous: { appoint_date: "2026-11-20", time_mode: "exact", time_start: "09:30", time_end: null } };
    assert.doesNotMatch(rules.appointmentText(input), /ผู้นัด|Doctor|null/, `${lang} ${kind}`);
    assert.doesNotMatch(JSON.stringify(rules.appointmentFlex(input)), /ผู้นัด|Doctor/, `flex ${lang} ${kind}`);
  }
});

test("ผู้นัด: บันทึกชื่อสะอาด ว่างได้ แก้นัดเดิมให้ว่างได้ และชื่อที่ใช้ถูกเพิ่มในรายชื่อ", async () => {
  resetDb();
  const { appointment } = await store.createAppointment({ patient_name: "แดง", appoint_date: inDays(3), time_mode: "exact", time_start: "10:00", provider: "  นพ.สมชาย   ใจดี " }, "agent");
  assert.equal(appointment.provider, "นพ.สมชาย ใจดี");
  assert.ok((state.tables.providers ?? []).some((p) => p.name === "นพ.สมชาย ใจดี"), "ชื่อที่ใช้ในนัดเข้า providers");
  const { appointment: none } = await store.createAppointment({ patient_name: "ดำ", appoint_date: inDays(3), time_mode: "exact", time_start: "10:30", provider: "" }, "agent");
  assert.equal(none.provider, null);
  const { appointment: edited } = await store.updateAppointment(appointment.id, { provider: "" }, "agent");
  assert.equal(edited.provider, null, "เลือก — ไม่ระบุ — แล้วนัดเดิมว่างได้");
});

test("หน้านัดหมาย: ปุ่มแท็บเรียง วันนี้ → พรุ่งนี้ → ทั้งหมด และเปิดมาที่วันนี้", () => {
  const src = readFileSync("src/app/(staff)/appointments/appointments-client.tsx", "utf8");
  assert.match(src, /const TABS: \[Tab, string\]\[\] = \[\["today", "วันนี้"\], \["tomorrow", "พรุ่งนี้"\], \["all", "ทั้งหมด"\]\];/);
  assert.match(src, /const \[tab, setTab\] = useState<Tab>\("today"\);/);
});

test("จับคู่ HN อัตโนมัติ: เฉพาะชื่อตรง 100% และไม่กำกวม", () => {
  const pick = rules.pickExactNameMatches;
  const visits = [
    { hn: "000004812", patient_name: "นางสาว ปัณณธร ใจดี" },
    { hn: "355", patient_name: "นาย สมชาย ทองดี" },
    { hn: "356", patient_name: "นาย สมชาย ทองดี" },
    { hn: "900", patient_name: "วิไล ศรีสุข" },
  ];
  const none = new Set(), noPhone = new Map();
  // คำนำหน้า/เว้นวรรคต่างได้ ตัวอักษรต้องตรงทุกตัว
  assert.deepEqual(pick([{ id: "a", patient_name: "ปัณณธร  ใจดี", phone: null }], visits, none, noPhone),
    [{ appointmentId: "a", hn: "000004812", hisName: "นางสาว ปัณณธร ใจดี" }]);
  assert.deepEqual(pick([{ id: "a", patient_name: "ปัณณธร ใจดีย์", phone: null }], visits, none, noPhone), []);
  // visit ชื่อซ้ำสอง HN → ไม่จับ
  assert.deepEqual(pick([{ id: "b", patient_name: "สมชาย ทองดี", phone: null }], visits, none, noPhone), []);
  // นัดไม่มี HN ชื่อเดียวกันสองนัด → ไม่จับ
  assert.deepEqual(pick([{ id: "c", patient_name: "วิไล ศรีสุข", phone: null }, { id: "d", patient_name: "วิไล ศรีสุข", phone: null }], visits, none, noPhone), []);
  // HN นี้มีนัดวันนี้อยู่แล้ว → ไม่ใช่คนไข้ใหม่
  assert.deepEqual(pick([{ id: "e", patient_name: "วิไล ศรีสุข", phone: null }], visits, new Set(["0900"]), noPhone), []);
  // เบอร์รู้ทั้งสองฝั่งแต่ไม่ตรง → ไม่จับ · ตรง → จับ
  assert.deepEqual(pick([{ id: "f", patient_name: "วิไล ศรีสุข", phone: "081-111-1111" }], visits, none, new Map([["900", "0822222222"]])), []);
  assert.equal(pick([{ id: "f", patient_name: "วิไล ศรีสุข", phone: "081-111-1111" }], visits, none, new Map([["900", "0811111111"]])).length, 1);
  // ชื่อสั้นเกิน → ไม่จับ
  assert.deepEqual(pick([{ id: "g", patient_name: "นาย อ", phone: null }], [{ hn: "1", patient_name: "อ" }], none, noPhone), []);
});
