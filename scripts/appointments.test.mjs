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
  assert.equal(newConv.last_direction ?? null, null, "ไม่เข้ารอตอบ");
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
  assert.equal(names.contactName(contact("c-line")), "ชื่อ HIS · HN 5");
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
  assert.equal(rules.timePhrase(slot), "มาได้ช่วง 08.00–12.00 น. (ตรวจตามลำดับคิว)");
  assert.equal(rules.timePhrase(exact), "เวลา 09.30 น.");
  assert.equal(rules.timePhrase(slot, "en"), "Please come between 08:00–12:00 (seen in queue order)");
  assert.equal(rules.timePhrase(exact, "en"), "at 09:30");
  assert.equal(rules.timeShort(slot), "08.00–12.00");
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
  assert.match(flex.altText, /มาได้ช่วง 13\.00–18\.00 น\. \(ตรวจตามลำดับคิว\)/);

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
  for (const f of ["src/app/(staff)/appointments/[id]/print/print-client.tsx", "src/app/(staff)/appointments/appointments-client.tsx", "src/lib/appointment-store.ts", "src/lib/appointment-rules.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /appoint_time|(?<!opts)\.purpose\b/, f);
  }
  const slip = readFileSync("src/app/(staff)/appointments/[id]/print/print-client.tsx", "utf8");
  assert.match(slip, /timePhrase\(a\)/);
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
