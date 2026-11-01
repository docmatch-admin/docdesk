// ทดสอบคะแนนเจ้าหน้าที่ด้วยโค้ดจริงของ pipeline: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { reset, replies } = await import(fake("ai"));
const { nextTime, resetDb, setClock, state } = await import(fake("admin"));
const { aiTiming, processIncoming, sendReply, starMessage, storeIncoming } = await import("../src/lib/pipeline.ts");
const { buildResponseEvent, buildTeamReport, DEFAULT_SCORE_RULES, normalizeScoreRules, periodStart, speedPoints } = await import("../src/lib/scoring.ts");
const closeRoute = await import("../src/app/api/conversations/[id]/close/route.ts");
const teamRoute = await import("../src/app/api/reports/team/route.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const HOURS = {
  tz: "Asia/Bangkok",
  days: { 0: ["08:00", "12:00"], 1: ["08:00", "18:00"], 2: ["08:00", "18:00"], 3: ["08:00", "18:00"], 4: ["08:00", "18:00"], 5: ["08:00", "18:00"], 6: ["08:00", "12:00"] },
};
const LONG = "ไข้หวัดใหญ่เข็มละ 390 บาทค่ะ";
const th = (s) => `2026-11-02T${s}+07:00`; // วันจันทร์

function setup(mode = "off") {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: mode }, { key: "business_hours", value: HOURS }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [],
    conversations: [],
    staff: [
      { id: "a", role: "agent", active: true, display_name: "ก้อย" },
      { id: "b", role: "agent", active: true, display_name: "บี" },
      { id: "admin", role: "admin", active: true, display_name: "Admin" },
    ],
    tags: [{ id: "t", name: "นัดแล้ว" }],
    tag_rules: [], tag_events: [], assignment_log: [], reply_examples: [], response_events: [], score_events: [],
  });
  aiTiming.debounceMs = 1;
  state.currentUser = { id: "a", email: "a@test" };
  setClock(th("10:00:00"));
}
beforeEach(() => setup());

const customerAt = async (time, text = "วัคซีนราคาเท่าไหร่คะ") => {
  setClock(time);
  const stored = await storeIncoming({ channelType: "web", externalId: SESSION, text });
  // การบันทึกหนึ่งครั้งเดินนาฬิกาจำลองหลายก้าว จึงตั้งเวลาข้อความให้ตรงเป๊ะ
  state.tables.messages.find((m) => m.id === stored.messageId).created_at = new Date(time).toISOString();
  return stored;
};
const replyAt = async (time, id, staff = "a", text = LONG) => {
  setClock(time);
  return sendReply({ conversationId: id, textTh: text, senderType: "staff", senderId: staff });
};
const events = () => state.tables.response_events;
const scores = () => state.tables.score_events;

// ---- เกณฑ์คะแนน ----
for (const [seconds, points] of [[0, 3], [120, 3], [121, 2], [300, 2], [301, 1], [900, 1], [901, 0], [99999, 0]]) {
  test(`ตอบใน ${seconds} วินาที: ${points} คะแนน`, () => {
    assert.equal(speedPoints(seconds, 50, DEFAULT_SCORE_RULES), points);
  });
}

test("คำตอบสั้นกว่า 15 ตัวอักษรได้ครึ่งเดียว ครบ 15 ได้เต็ม", () => {
  assert.equal(speedPoints(60, 14, DEFAULT_SCORE_RULES), 1.5);
  assert.equal(speedPoints(60, 15, DEFAULT_SCORE_RULES), 3);
  assert.equal(speedPoints(200, 3, DEFAULT_SCORE_RULES), 1);
});

test("ตั้งเกณฑ์เองได้ และค่าเสียใช้ค่าเริ่มต้น", () => {
  const r = normalizeScoreRules({ speed: [{ maxSeconds: 600, points: 5 }, { maxSeconds: 60, points: 9 }], shortChars: 5, starPoints: 4, closePoints: 0 });
  assert.equal(speedPoints(30, 50, r), 9, "เรียงขั้นตามเวลาให้เอง");
  assert.equal(speedPoints(500, 50, r), 5);
  assert.equal(speedPoints(500, 4, r), 2.5);
  assert.equal(r.closePoints, 0);
  for (const bad of [null, "x", {}, { speed: [], starPoints: -1, closePoints: "a" }, { speed: [{ maxSeconds: "a" }] }]) {
    assert.deepEqual(normalizeScoreRules(bad), DEFAULT_SCORE_RULES, JSON.stringify(bad));
  }
});

// ---- กรณีที่สั่ง ----
test("ตอบนอกเวลา: ลูกค้าทักตอนกลางคืน ตอบตอนเปิด 2 นาที ได้ 3 คะแนน", async () => {
  const s = await customerAt("2026-11-01T22:30:00+07:00");
  await replyAt(th("08:02:00"), s.conversationId);
  const [e] = events();
  assert.equal(e.business_seconds, 120);
  assert.ok(e.response_seconds > 30000, "เวลาจริงยังเก็บไว้");
  assert.equal(e.points, 3);
});

test("ตอบนอกเวลา: ลูกค้าทักตอนกลางคืน ตอบตอนเปิด 20 นาที ได้ 0", async () => {
  const s = await customerAt("2026-11-01T22:30:00+07:00");
  await replyAt(th("08:20:00"), s.conversationId);
  assert.equal(events()[0].points, 0);
});

test("ตอบนอกเวลาทำการ: นับเฉพาะช่วงที่เปิด ไม่เสียคะแนน", async () => {
  const s = await customerAt(th("17:59:00"));
  await replyAt(th("21:00:00"), s.conversationId);
  assert.equal(events()[0].business_seconds, 60);
  assert.equal(events()[0].points, 3);
});

test("ตอบแชทเพื่อน: คะแนนไปที่คนตอบ ผู้ดูแลไม่เปลี่ยน", async () => {
  const s = await customerAt(th("10:00:00"));
  state.tables.conversations[0].assigned_to = "b";
  await replyAt(th("10:01:00"), s.conversationId, "a");
  assert.equal(events()[0].replied_by, "a");
  assert.equal(state.tables.conversations[0].assigned_to, "b");
});

test("AI ตอบก่อน: เจ้าหน้าที่ตอบต่อไม่ได้คะแนนความเร็ว", async () => {
  const s = await customerAt(th("10:00:00"));
  setClock(th("10:00:30"));
  await sendReply({ conversationId: s.conversationId, textTh: "AI ตอบแล้วค่ะ", senderType: "ai" });
  await replyAt(th("10:01:00"), s.conversationId);
  assert.equal(events().length, 0);
});

test("AI ตอบเองในโหมด auto: ไม่มีคะแนน", async () => {
  setup("auto");
  replies.next = { needs_human: false, suggested_tags: [], options: [{ text: "ตอบเองค่ะ", source: "knowledge", ref_ids: [], confidence: 0.9 }] };
  const s = await customerAt(th("10:00:00"));
  await processIncoming(s.conversationId, s.messageId);
  assert.equal(events().length, 0);
});

test("ดาวข้อความตัวเอง: ไม่ได้คะแนน แต่ดาวติด", async () => {
  const s = await customerAt(th("10:00:00"));
  const r = await replyAt(th("10:01:00"), s.conversationId, "a");
  await starMessage(r.messageId, "a");
  assert.equal(scores().length, 0);
  assert.equal(state.tables.messages.find((m) => m.id === r.messageId).starred, true);
});

test("ดาวข้อความเพื่อน: +2 ให้คนส่ง ไม่ใช่คนกดดาว", async () => {
  const s = await customerAt(th("10:00:00"));
  const r = await replyAt(th("10:01:00"), s.conversationId, "a");
  await starMessage(r.messageId, "b");
  assert.deepEqual(scores().map((x) => [x.staff_id, x.kind, x.points]), [["a", "star", 2]]);
});

test("กดดาวซ้ำ: ไม่ได้คะแนนเพิ่ม", async () => {
  const s = await customerAt(th("10:00:00"));
  const r = await replyAt(th("10:01:00"), s.conversationId, "a");
  await starMessage(r.messageId, "b");
  await starMessage(r.messageId, "admin");
  assert.equal(scores().length, 1);
});

test("ดาวข้อความของ AI: ไม่มีใครได้คะแนน", async () => {
  const s = await customerAt(th("10:00:00"));
  setClock(th("10:00:30"));
  const r = await sendReply({ conversationId: s.conversationId, textTh: "AI ตอบค่ะ", senderType: "ai" });
  await starMessage(r.messageId, "b");
  assert.equal(scores().length, 0);
});

test("คำตอบสั้น: ได้ครึ่งเดียว", async () => {
  const s = await customerAt(th("10:00:00"));
  await replyAt(th("10:01:00"), s.conversationId, "a", "ได้ค่ะ");
  assert.equal(events()[0].points, 1.5);
  assert.equal(events()[0].reply_length, 6);
});

// ---- ไม่นับ ----
for (const text of ["ขอบคุณค่ะ", "รับทราบครับ", "โอเคค่ะ", "👍", "[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]", "[ลูกค้าส่งสติกเกอร์ — เปิดดูใน Meta]"]) {
  test(`ตอบข้อความ "${text}": ไม่นับ`, async () => {
    const s = await customerAt(th("10:00:00"), text);
    await replyAt(th("10:01:00"), s.conversationId);
    assert.equal(events().length, 0);
  });
}

test("คำขอบคุณนำหน้าคำถาม: เริ่มนับจากคำถาม", async () => {
  const a = await customerAt(th("10:00:00"), "ขอบคุณค่ะ");
  const b = await customerAt(th("10:10:00"), "แล้วราคาเท่าไหร่คะ");
  await replyAt(th("10:11:00"), a.conversationId);
  assert.equal(events()[0].inbound_message_id, b.messageId);
  assert.equal(events()[0].points, 3);
});

test("หลายข้อความติดกัน: นับจากข้อความแรก ได้ event เดียว", async () => {
  const a = await customerAt(th("10:00:00"), "สวัสดีค่ะ");
  await customerAt(th("10:04:00"), "ราคาเท่าไหร่คะ");
  await replyAt(th("10:05:00"), a.conversationId);
  assert.equal(events().length, 1);
  assert.equal(events()[0].business_seconds, 300);
  assert.equal(events()[0].points, 2);
});

test("ตอบหลายข้อความติดกัน: ได้คะแนนเฉพาะข้อความแรก", async () => {
  const s = await customerAt(th("10:00:00"));
  await replyAt(th("10:01:00"), s.conversationId);
  await replyAt(th("10:02:00"), s.conversationId);
  await replyAt(th("10:03:00"), s.conversationId, "b");
  assert.equal(events().length, 1);
  assert.equal(events()[0].replied_by, "a");
});

test("ลูกค้าถามรอบใหม่: นับเป็น event ใหม่", async () => {
  const s = await customerAt(th("10:00:00"));
  await replyAt(th("10:01:00"), s.conversationId);
  await customerAt(th("11:00:00"), "แล้วเด็กฉีดได้ไหมคะ");
  await replyAt(th("11:03:00"), s.conversationId, "b");
  assert.deepEqual(events().map((e) => [e.replied_by, e.points]), [["a", 3], ["b", 2]]);
});

test("ข้อความก่อนกดเสร็จแล้วไม่นับ", () => {
  const msg = (id, created_at) => ({ id, direction: "in", body: "ราคาเท่าไหร่", created_at });
  const e = buildResponseEvent({
    conversationId: "c", replyId: "r", staffId: "a", replyText: LONG, repliedAt: th("12:01:00"),
    messages: [msg("old", th("09:00:00")), msg("new", th("12:00:00"))],
    closedAt: th("11:00:00"), hours: HOURS, rules: DEFAULT_SCORE_RULES,
  });
  assert.equal(e.inbound_message_id, "new");
  assert.equal(buildResponseEvent({
    conversationId: "c", replyId: "r", staffId: "a", replyText: LONG, repliedAt: th("12:01:00"),
    messages: [msg("old", th("09:00:00"))], closedAt: th("11:00:00"), hours: HOURS, rules: DEFAULT_SCORE_RULES,
  }), null);
});

test("รูปอย่างเดียว: นับ เพราะต้องให้คนตอบ", async () => {
  setClock(th("10:00:00"));
  const s = await storeIncoming({ channelType: "web", externalId: SESSION, text: "", isImage: true });
  await replyAt(th("10:01:00"), s.conversationId);
  assert.equal(events().length, 1);
});

test("บันทึกคะแนนล้มเหลว: ข้อความยังส่งสำเร็จ", async (t) => {
  t.mock.method(console, "error", () => {});
  const s = await customerAt(th("10:00:00"));
  state.tables.settings.find((x) => x.key === "business_hours").value = null;
  state.tables.response_events = null;
  const r = await replyAt(th("10:01:00"), s.conversationId);
  assert.ok(r.messageId);
});

// ---- กดเสร็จแล้ว ----
const close = (id, body = {}) => closeRoute.POST(
  new Request("https://app.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

test("กดเสร็จแล้ว: +1 ให้คนที่ตอบล่าสุด ไม่ใช่คนกด", async () => {
  const s = await customerAt(th("10:00:00"));
  await replyAt(th("10:01:00"), s.conversationId, "b");
  state.currentUser = { id: "a", email: "a@test" };
  assert.equal((await close(s.conversationId)).status, 200);
  assert.deepEqual(scores().map((x) => [x.staff_id, x.kind, x.points]), [["b", "close", 1]]);
  assert.equal(state.tables.conversations[0].status, "closed");
  assert.equal(state.tables.conversations[0].needs_human, false);
});

test("กดเสร็จแล้วโดยยังไม่มีคนตอบ: ไม่มีคะแนน", async () => {
  const s = await customerAt(th("10:00:00"));
  await close(s.conversationId);
  assert.equal(scores().length, 0);
});

test("AI ตอบล่าสุด: คะแนนไปที่เจ้าหน้าที่คนล่าสุด ถ้าไม่มีก็ไม่ได้", async () => {
  const s = await customerAt(th("10:00:00"));
  setClock(th("10:00:30"));
  await sendReply({ conversationId: s.conversationId, textTh: "AI ตอบค่ะ", senderType: "ai" });
  await close(s.conversationId);
  assert.equal(scores().length, 0);
});

test("กันปั๊มคะแนน: เปิดใหม่แล้วกดเสร็จซ้ำโดยไม่มีคำตอบใหม่ ไม่ได้เพิ่ม", async () => {
  const s = await customerAt(th("10:00:00"));
  await replyAt(th("10:01:00"), s.conversationId);
  await close(s.conversationId);
  state.tables.conversations[0].status = "open";
  await close(s.conversationId);
  assert.equal(scores().length, 1);
});

test("เปิดใหม่ ตอบใหม่ แล้วกดเสร็จ: ได้อีกครั้ง", async () => {
  const s = await customerAt(th("10:00:00"));
  await replyAt(th("10:01:00"), s.conversationId);
  await close(s.conversationId);
  await customerAt(th("11:00:00"), "ถามเพิ่มค่ะ");
  await replyAt(th("11:01:00"), s.conversationId, "b");
  await close(s.conversationId);
  assert.deepEqual(scores().map((x) => x.staff_id), ["a", "b"]);
});

test("กดเสร็จแล้วซ้ำในแชทที่เสร็จแล้ว: ไม่ได้เพิ่ม", async () => {
  const s = await customerAt(th("10:00:00"));
  await replyAt(th("10:01:00"), s.conversationId);
  await close(s.conversationId);
  await close(s.conversationId);
  assert.equal(scores().length, 1);
});

test("กดเสร็จแล้วพร้อมแท็ก: ติดแท็ก, แท็กไม่มีจริง 400 และไม่ปิด", async () => {
  const s = await customerAt(th("10:00:00"));
  assert.equal((await close(s.conversationId, { tag: "มั่ว" })).status, 400);
  assert.equal(state.tables.conversations[0].status, "open");
  assert.equal((await close(s.conversationId, { tag: "นัดแล้ว" })).status, 200);
  assert.deepEqual(state.tables.conversations[0].tags, ["นัดแล้ว"]);
});

test("กดเสร็จแล้ว: ไม่ล็อกอิน 401, ไม่พบแชท 404", async () => {
  assert.equal((await close("missing")).status, 404);
  state.currentUser = null;
  assert.equal((await close("x")).status, 401);
});

// ---- รายงานทีม ----
const staff = [{ id: "a", display_name: "ก้อย", active: true }, { id: "b", display_name: "บี", active: true }, { id: "c", display_name: "ใหม่", active: true }, { id: "x", display_name: "ลาออก", active: false }];
const resp = (replied_by, conversation_id, business_seconds, points) => ({ replied_by, conversation_id, business_seconds, points });

test("รายงาน: นับแชทไม่ซ้ำ, median, % ใน 5 นาที, คะแนนแยกประเภท", () => {
  const rows = buildTeamReport(
    [resp("a", "c1", 60, 3), resp("a", "c1", 100, 3), resp("a", "c2", 400, 1), resp("a", "c3", 1000, 0), resp("b", "c4", 30, "1.50")],
    [{ staff_id: "a", points: "2" }, { staff_id: "a", points: 1 }],
    staff,
  );
  const a = rows.find((r) => r.staffId === "a");
  assert.equal(a.chats, 3);
  assert.equal(a.medianSeconds, 250);
  assert.equal(a.within5Percent, 50);
  assert.equal(a.speedPoints, 7);
  assert.equal(a.qualityPoints, 3);
  assert.equal(a.total, 10);
  assert.equal(rows.find((r) => r.staffId === "b").total, 1.5);
});

test("รายงาน: จัดอันดับ คะแนนเท่ากันอันดับเดียวกัน คนไม่มีงานยังแสดง บัญชีที่ปิดไม่มีงานไม่แสดง", () => {
  const rows = buildTeamReport([resp("a", "c1", 60, 3), resp("b", "c2", 60, 3)], [], staff);
  assert.deepEqual(rows.map((r) => [r.staffId, r.rank]), [["a", 1], ["b", 1], ["c", 3]]);
  const c = rows.find((r) => r.staffId === "c");
  assert.equal(c.medianSeconds, null);
  assert.equal(c.within5Percent, null);
});

test("รายงาน: บัญชีที่ปิดแต่มีงานในช่วงนั้นยังแสดง", () => {
  assert.ok(buildTeamReport([resp("x", "c1", 60, 3)], [], staff).some((r) => r.staffId === "x"));
});

test("ช่วงเวลารายงานตามเวลาไทย สัปดาห์เริ่มวันจันทร์", () => {
  const wed = Date.parse("2026-11-04T20:00:00Z"); // พฤหัส 5 พ.ย. ตี 3 เวลาไทย
  assert.equal(periodStart("day", wed), "2026-11-05T00:00:00+07:00");
  assert.equal(periodStart("week", wed), "2026-11-02T00:00:00+07:00");
  assert.equal(periodStart("month", wed), "2026-11-01T00:00:00+07:00");
  const sunday = Date.parse("2026-11-08T05:00:00Z");
  assert.equal(periodStart("week", sunday), "2026-11-02T00:00:00+07:00");
});

test("API รายงาน: agent เห็นตัวเลขตัวเอง และอันดับแบบชื่อกับคะแนนรวมเท่านั้น", async () => {
  state.tables.response_events = [
    { replied_by: "a", conversation_id: "c1", business_seconds: 60, points: 3, replied_at: new Date().toISOString() },
    { replied_by: "b", conversation_id: "c2", business_seconds: 60, points: 2, replied_at: new Date().toISOString() },
  ];
  state.currentUser = { id: "a", email: "a@test" };
  const j = await (await teamRoute.GET(new Request("https://app.test/x?period=day"))).json();
  assert.deepEqual(j.rows.map((r) => r.staffId), ["a"]);
  assert.equal(j.ranking.length, 3);
  assert.deepEqual(Object.keys(j.ranking[0]).sort(), ["name", "rank", "staffId", "total"]);
  assert.ok(!JSON.stringify(j.ranking).includes("medianSeconds"));
});

test("API รายงาน: admin เห็นทุกคน, ไม่ล็อกอิน 401", async () => {
  state.currentUser = { id: "admin", email: "x@test" };
  const j = await (await teamRoute.GET(new Request("https://app.test/x?period=week"))).json();
  assert.equal(j.rows.length, 3);
  state.currentUser = null;
  assert.equal((await teamRoute.GET(new Request("https://app.test/x"))).status, 401);
});
