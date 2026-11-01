// ทดสอบการรับ-ส่งรูปภาพ: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import vm from "node:vm";
import sharp from "sharp";
import { fake } from "./fakes/hooks.mjs";

const { calls, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { detectImageType, downloadLimited, MAX_WEB_IMAGE_BYTES, MediaError, processImage } = await import("../src/lib/media.ts");
const { buildOutMediaUrl, OUT_URL_TTL_SECONDS, verifyOutMediaSignature } = await import("../src/lib/media-url.ts");
const { attachWidgetMedia, CHAT_BUCKET, consumeUpload, IMAGE_FAILED_TEXT, ingestInboundImage, purgeExpiredMedia, purgeStaleUploads, QUICK_BUCKET } = await import("../src/lib/media-store.ts");
const { lineContentRequest, lineSendImage } = await import("../src/lib/channels/line.ts");
const { metaSendImage, MetaWindowError } = await import("../src/lib/channels/meta.ts");
const { aiTiming, processIncoming, sendMediaReply, storeIncoming } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");

process.env.MEDIA_URL_SECRET = "test-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
process.env.META_PAGE_ACCESS_TOKEN = "page-token";

const noise = (w, h, extra = {}) => sharp({ create: { width: w, height: h, channels: 3, background: "#3366cc", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).png().toBuffer().then((b) => sharp(b, extra));
const meta = (buf) => sharp(buf).metadata();
const isJpeg = (buf) => buf[0] === 0xff && buf[1] === 0xd8;

// ---- บีบอัด ----
for (const [name, encode] of [
  ["JPEG", (s) => s.jpeg()],
  ["PNG", (s) => s.blur(20).png()], // noise แบบ PNG ใหญ่เกิน 10MB
  ["WebP", (s) => s.webp()],
]) {
  test(`บีบอัด ${name}: ภาพหลักยาวสุด 1600px, preview 240px, เป็น JPEG`, async () => {
    const input = await encode(await noise(3000, 2000)).toBuffer();
    const out = await processImage(input);
    const main = await meta(out.main);
    const preview = await meta(out.preview);
    assert.equal(main.format, "jpeg");
    assert.deepEqual([main.width, main.height, out.width, out.height], [1600, 1067, 1600, 1067]);
    assert.equal(preview.format, "jpeg");
    assert.deepEqual([preview.width, preview.height], [240, 160]);
    assert.ok(out.preview.length < out.main.length);
  });
}

test("บีบอัด HEIC จากไฟล์จริง", async () => {
  const input = readFileSync("scripts/fixtures/sample.heic");
  assert.equal(detectImageType(input), "heic");
  const out = await processImage(input);
  assert.ok(isJpeg(out.main));
  const main = await meta(out.main);
  assert.ok(Math.max(main.width, main.height) <= 1600);
});

test("รูปเล็กไม่ถูกขยาย", async () => {
  const out = await processImage(await (await noise(300, 200)).jpeg().toBuffer());
  assert.deepEqual([out.width, out.height], [300, 200]);
  assert.deepEqual([(await meta(out.preview)).width], [240]);
});

test("ตัด EXIF ทิ้ง และหมุนรูปตาม orientation", async () => {
  const input = await (await noise(400, 200)).withExif({ IFD0: { Copyright: "secret-location" } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const out = await processImage(input);
  const m = await meta(out.main);
  assert.equal(m.exif, undefined);
  assert.deepEqual([m.width, m.height], [200, 400]);
});

test("PNG โปร่งใสไม่กลายเป็นพื้นดำ", async () => {
  const input = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const out = await processImage(input);
  const { data } = await sharp(out.main).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 250);
});

// ---- ปฏิเสธไฟล์ ----
const code = (c) => (e) => e instanceof MediaError && e.code === c;

test("ไฟล์ปลอมนามสกุล .jpg: ปฏิเสธจาก magic bytes", async () => {
  await assert.rejects(processImage(Buffer.from("<html><script>alert(1)</script> fake.jpg ................")), code("unsupported"));
  await assert.rejects(processImage(Buffer.from("%PDF-1.7 pretend this is photo.jpg ....")), code("unsupported"));
  await assert.rejects(processImage(Buffer.from("GIF89a..............")), code("unsupported"));
  await assert.rejects(processImage(Buffer.alloc(0)), code("unsupported"));
});

test("magic bytes ถูกแต่เนื้อไฟล์เสีย: ปฏิเสธ", async (t) => {
  t.mock.method(console, "error", () => {});
  const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
  await assert.rejects(processImage(fake), code("corrupt"));
});

test("เกินขนาด: ปฏิเสธก่อนถอดรหัส", async () => {
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_WEB_IMAGE_BYTES)]);
  await assert.rejects(processImage(big, MAX_WEB_IMAGE_BYTES), code("too_large"));
});

test("เลือกชนิดจากเนื้อไฟล์ ไม่ใช่นามสกุล", async () => {
  const png = await (await noise(10, 10)).png().toBuffer();
  assert.equal(detectImageType(png), "png");
});

// ---- ลายเซ็น URL ----
const NOW = Date.parse("2026-11-01T00:00:00Z");
const params = (url) => { const u = new URL(url); return { v: u.searchParams.get("v"), exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") }; };

test("ลายเซ็นถูกต้องใช้ได้ หมดอายุใน 30 วัน", () => {
  const p = params(buildOutMediaUrl("https://app.test", "m1", "main", NOW));
  assert.equal(verifyOutMediaSignature("m1", p, NOW), true);
  assert.equal(verifyOutMediaSignature("m1", p, NOW + (OUT_URL_TTL_SECONDS - 1) * 1000), true);
  assert.equal(verifyOutMediaSignature("m1", p, NOW + OUT_URL_TTL_SECONDS * 1000), false);
  assert.equal(OUT_URL_TTL_SECONDS, 30 * 24 * 60 * 60);
});

test("ลายเซ็นผิดหรือถูกแก้ไม่ผ่าน", () => {
  const p = params(buildOutMediaUrl("https://app.test", "m1", "preview", NOW));
  assert.equal(verifyOutMediaSignature("m1", { ...p, sig: "0".repeat(64) }, NOW), false);
  assert.equal(verifyOutMediaSignature("m1", { ...p, sig: null }, NOW), false);
  assert.equal(verifyOutMediaSignature("m2", p, NOW), false, "ใช้กับข้อความอื่นไม่ได้");
  assert.equal(verifyOutMediaSignature("m1", { ...p, v: "main" }, NOW), false, "เปลี่ยนจาก preview เป็นรูปใหญ่ไม่ได้");
  assert.equal(verifyOutMediaSignature("m1", { ...p, exp: String(Number(p.exp) + 999) }, NOW), false, "ต่ออายุเองไม่ได้");
  assert.equal(verifyOutMediaSignature("m1", { ...p, exp: "abc" }, NOW), false);
  assert.equal(verifyOutMediaSignature("m1", p, NOW, "other-secret"), false);
  assert.equal(verifyOutMediaSignature("m1", p, NOW, ""), false);
});

// ---- ส่งไปแพลตฟอร์ม ----
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockFetch(handler = () => new Response("{}", { status: 200 })) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(init.body) : null };
    sent.push(call);
    return handler(call);
  };
  return sent;
}

test("LINE ส่งรูป: ใช้ replyToken ก่อน และ caption เป็นข้อความถัดไปในครั้งเดียว", async () => {
  const sent = mockFetch();
  await lineSendImage("U1", "https://a/main", "https://a/prev", "แผนที่ค่ะ", "T1");
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/message\/reply$/);
  assert.equal(sent[0].body.replyToken, "T1");
  assert.deepEqual(sent[0].body.messages, [
    { type: "image", originalContentUrl: "https://a/main", previewContentUrl: "https://a/prev" },
    { type: "text", text: "แผนที่ค่ะ" },
  ]);
});

test("LINE ส่งรูป: reply ไม่สำเร็จ fallback เป็น push และไม่มี caption ไม่ส่งข้อความเปล่า", async () => {
  const sent = mockFetch((c) => new Response("{}", { status: c.url.endsWith("/reply") ? 400 : 200 }));
  await lineSendImage("U1", "https://a/main", "https://a/prev", "", "T1");
  assert.deepEqual(sent.map((c) => c.url.split("/").pop()), ["reply", "push"]);
  assert.equal(sent[1].body.to, "U1");
  assert.equal(sent[1].body.messages.length, 1);
});

test("LINE ดาวน์โหลดรูปจาก api-data", () => {
  const r = lineContentRequest("123");
  assert.equal(r.url, "https://api-data.line.me/v2/bot/message/123/content");
  assert.equal(r.headers.Authorization, "Bearer line-token");
});

test("Meta ส่งรูปตามกติกา 24 ชม.", async () => {
  const sent = mockFetch();
  const now = Date.now();
  await metaSendImage("facebook", "U1", "https://a/main", "", { lastInboundAt: new Date(now - 3_600_000), senderType: "staff" });
  assert.deepEqual(sent[0].body, {
    recipient: { id: "U1" },
    message: { attachment: { type: "image", payload: { url: "https://a/main" } } },
    messaging_type: "RESPONSE",
  });
  await assert.rejects(
    metaSendImage("instagram", "U1", "https://a/main", "", { lastInboundAt: new Date(now - 8 * 86_400_000), senderType: "staff" }),
    MetaWindowError,
  );
  assert.equal(sent.length, 1);
});

test("ดาวน์โหลดหยุดเมื่อเกินขนาด และรับเฉพาะ https", async () => {
  mockFetch(() => new Response(Buffer.alloc(2000)));
  await assert.rejects(downloadLimited("https://cdn.test/a", {}, 1000), code("too_large"));
  assert.equal((await downloadLimited("https://cdn.test/a", {}, 5000)).length, 2000);
  await assert.rejects(downloadLimited("http://169.254.169.254/latest", {}, 1000), /https/);
});

// ---- ขาเข้าและ AI ----
const SESSION = "11111111-1111-4111-8111-111111111111";
function setup(mode = "auto", type = "web") {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: mode }],
    channels: [{ id: "ch", type, ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [],
    conversations: [],
  });
  aiTiming.debounceMs = 10;
}
const conv = () => state.tables.conversations[0];
const storeImageMsg = (extra = {}) => storeIncoming({ channelType: "web", externalId: SESSION, text: "", isImage: true, ...extra });
const msgRow = (id) => state.tables.messages.find((m) => m.id === id);

beforeEach(() => setup());

test("ลูกค้าส่งแต่รูป: needs_human, ไม่แปล, ไม่สร้างคำแนะนำ", async () => {
  const s = await storeImageMsg();
  assert.equal(conv().needs_human, true);
  assert.equal(conv().last_message_preview, "[รูปภาพ]");
  const r = await generateSuggestions(s.conversationId);
  assert.equal(r.skipped, "no_reply_needed");
  assert.deepEqual(calls, { chat: 0, embed: 0 });
  assert.equal(state.tables.suggestions.length, 0);
});

test("ข้อความตามด้วยรูปในช่วงรอ: ยังร่างคำตอบของข้อความนั้น", async () => {
  const t = await storeIncoming({ channelType: "web", externalId: SESSION, text: "วัคซีนราคาเท่าไหร่" });
  await storeImageMsg();
  await processIncoming(t.conversationId, t.messageId);
  assert.equal(calls.chat, 1);
});

test("ข้อความตามด้วยไฟล์แนบอื่น: ยังร่างคำตอบของข้อความนั้น", async () => {
  const t = await storeIncoming({ channelType: "web", externalId: SESSION, text: "วัคซีนราคาเท่าไหร่" });
  await storeIncoming({ channelType: "web", externalId: SESSION, text: "[ลูกค้าส่ง sticker — เปิดดูใน LINE OA]" });
  await processIncoming(t.conversationId, t.messageId);
  assert.equal(calls.chat, 1);
});

test("รูปตามด้วยข้อความ: ส่งให้ AI เฉพาะข้อความ ไม่มีบรรทัดว่าง", async () => {
  await storeImageMsg();
  const t = await storeIncoming({ channelType: "web", externalId: SESSION, text: "ราคาเท่าไหร่" });
  await processIncoming(t.conversationId, t.messageId);
  assert.equal(calls.chat, 1);
});

test("รูปเข้าดาวน์โหลดสำเร็จ: เก็บภาพหลักและ preview ใน bucket", async () => {
  const s = await storeImageMsg();
  const raw = await (await noise(2000, 1000)).jpeg().toBuffer();
  await ingestInboundImage(s.messageId, async () => raw);
  const m = msgRow(s.messageId);
  assert.equal(m.media_type, "image");
  assert.deepEqual([m.media_width, m.media_height], [1600, 800]);
  assert.ok(state.files[CHAT_BUCKET].has(m.media_path));
  assert.ok(state.files[CHAT_BUCKET].has(m.media_preview_path));
});

for (const [name, download] of [
  ["เครือข่ายล้มเหลว", async () => { throw new Error("network"); }],
  ["ไม่ใช่รูปจริง", async () => Buffer.from("not an image at all, sorry")],
]) {
  test(`รูปเข้าโหลดไม่สำเร็จ (${name}): เก็บข้อความแจ้งแทน`, async (t) => {
    t.mock.method(console, "error", () => {});
    const s = await storeImageMsg();
    await ingestInboundImage(s.messageId, download);
    const m = msgRow(s.messageId);
    assert.equal(m.body, IMAGE_FAILED_TEXT);
    assert.equal(m.media_type, null);
    assert.equal(m.media_path ?? null, null);
    assert.equal(conv().needs_human, true);
  });
}

// ---- ไฟล์พัก ----
test("ไฟล์ปลอมที่อัปโหลด: ปฏิเสธ และลบไฟล์พัก", async () => {
  state.files[CHAT_BUCKET] = new Map([["uploads/x", { data: Buffer.from("not an image, pretending to be .jpg") }]]);
  await assert.rejects(consumeUpload("uploads/x", CHAT_BUCKET, MAX_WEB_IMAGE_BYTES), code("unsupported"));
  assert.equal(state.files[CHAT_BUCKET].has("uploads/x"), false);
});

test("ไฟล์พักเกินเพดานของเว็บ: ปฏิเสธ แม้ bucket รับได้ถึง 10MB", async () => {
  state.files[CHAT_BUCKET] = new Map([["uploads/x", { data: Buffer.alloc(MAX_WEB_IMAGE_BYTES + 1, 1) }]]);
  await assert.rejects(consumeUpload("uploads/x", CHAT_BUCKET, MAX_WEB_IMAGE_BYTES), code("too_large"));
});

test("ไฟล์พักเก่าเกิน 1 ชั่วโมงถูกลบ ไฟล์ใหม่และรูปจริงอยู่ครบ", async () => {
  const at = (ms) => new Date(NOW - ms).toISOString();
  state.files[CHAT_BUCKET] = new Map([
    ["uploads/old", { data: Buffer.alloc(1), created_at: at(3_700_000) }],
    ["uploads/new", { data: Buffer.alloc(1), created_at: at(1000) }],
    ["2026-01/a.jpg", { data: Buffer.alloc(1), created_at: at(9_000_000) }],
  ]);
  assert.equal(await purgeStaleUploads(NOW), 1);
  assert.deepEqual([...state.files[CHAT_BUCKET].keys()], ["uploads/new", "2026-01/a.jpg"]);
});

// ---- ส่งรูป ----
function staffChat(type, lastInboundAgoMs = 1000) {
  setup("assist", type);
  state.tables.contacts.push({ id: "ct", channel_id: "ch", external_id: "U1", language: "th" });
  state.tables.conversations.push({ id: "c1", contact_id: "ct", channel_id: "ch", needs_human: true, line_reply_token: "T1", line_reply_token_at: new Date().toISOString() });
  state.tables.messages.push({ id: "in1", conversation_id: "c1", direction: "in", sender_type: "customer", body: "ขอแผนที่", created_at: new Date(Date.now() - lastInboundAgoMs).toISOString() });
}
const reply = (extra) => sendMediaReply({ conversationId: "c1", senderId: "s1", origin: "https://app.test", ...extra });
async function withUpload() {
  state.files[CHAT_BUCKET] = new Map([["uploads/staff-1", { data: await (await noise(800, 600)).jpeg().toBuffer() }]]);
  return "uploads/staff-1";
}

test("เจ้าหน้าที่ส่งรูปทาง LINE: URL มีลายเซ็นจริง ใช้ replyToken และล้างป้ายรอคนตอบ", async () => {
  staffChat("line");
  const uploadPath = await withUpload();
  const sent = mockFetch();
  const { messageId } = await reply({ uploadPath, captionTh: "แผนที่ค่ะ" });
  const image = sent[0].body.messages[0];
  assert.match(sent[0].url, /\/reply$/);
  assert.equal(new URL(image.originalContentUrl).pathname, `/api/media/out/${messageId}`);
  assert.equal(verifyOutMediaSignature(messageId, params(image.originalContentUrl)), true);
  assert.equal(params(image.previewContentUrl).v, "preview");
  assert.equal(verifyOutMediaSignature(messageId, params(image.previewContentUrl)), true);
  assert.equal(msgRow(messageId).direction, "out");
  assert.equal(msgRow(messageId).body, "แผนที่ค่ะ");
  assert.equal(conv().needs_human, false);
  assert.equal(state.files[CHAT_BUCKET].has("uploads/staff-1"), false);
});

test("ส่งรูปไม่สำเร็จ: ลบแถวข้อความและไฟล์ ไม่ค้างในแชท", async () => {
  staffChat("line");
  const uploadPath = await withUpload();
  mockFetch(() => new Response("nope", { status: 500 }));
  await assert.rejects(reply({ uploadPath }), /LINE push failed/);
  assert.equal(state.tables.messages.filter((m) => m.direction === "out").length, 0);
  assert.equal(state.files[CHAT_BUCKET].size, 0);
  assert.equal(conv().needs_human, true);
});

test("Facebook เกิน 7 วัน: ไม่ส่ง และไม่แตะไฟล์หรือข้อความ", async () => {
  staffChat("facebook", 8 * 86_400_000);
  const uploadPath = await withUpload();
  const sent = mockFetch();
  await assert.rejects(reply({ uploadPath }), MetaWindowError);
  assert.equal(sent.length, 0);
  assert.equal(state.files[CHAT_BUCKET].has(uploadPath), true);
  assert.equal(state.tables.messages.length, 1);
});

test("รูปที่ใช้บ่อย: คัดลอกเป็นไฟล์ของแชท ไฟล์ในคลังยังอยู่", async () => {
  staffChat("web");
  const main = await (await noise(500, 400)).jpeg().toBuffer();
  state.files[QUICK_BUCKET] = new Map([["q.jpg", { data: main }], ["q_p.jpg", { data: main }]]);
  state.tables.quick_media = [{ id: "q1", path: "q.jpg", preview_path: "q_p.jpg" }];
  const { messageId } = await reply({ quickMediaId: "q1" });
  const m = msgRow(messageId);
  assert.notEqual(m.media_path, "q.jpg");
  assert.ok(state.files[CHAT_BUCKET].has(m.media_path));
  assert.deepEqual([m.media_width, m.media_height], [500, 400]);
  assert.equal(state.files[QUICK_BUCKET].size, 2);
});

test("ไม่พบรูปที่ใช้บ่อย: แจ้ง error", async () => {
  staffChat("web");
  state.tables.quick_media = [];
  await assert.rejects(reply({ quickMediaId: "missing" }), /ไม่พบรูป/);
});

// ---- widget เห็นเฉพาะแชทตัวเอง ----
test("attachWidgetMedia: ออก signed URL เฉพาะแถวที่ส่งเข้ามา", async () => {
  const rows = [
    { id: "a", direction: "in", body: "", created_at: "t", media_path: "a.jpg", media_preview_path: "a_p.jpg" },
    { id: "b", direction: "out", body: "สวัสดี", created_at: "t", media_path: null, media_preview_path: null },
    { id: "c", direction: "in", body: "", created_at: "t", media_path: null, media_preview_path: null, media_deleted_at: "t" },
  ];
  const out = await attachWidgetMedia(rows);
  assert.match(out[0].media_url, /signed\/chat-media\/a\.jpg$/);
  assert.match(out[0].preview_url, /a_p\.jpg$/);
  assert.equal(out[1].media_url, undefined);
  assert.equal(out[2].media_deleted, true);
  assert.equal("media_path" in out[0], false, "ไม่ส่ง path ภายในให้เบราว์เซอร์ลูกค้า");
});

// ---- ลบตามอายุ ----
const DAY = 86_400_000;
function retentionData(setting) {
  setup("assist");
  if (setting !== undefined) state.tables.settings.push({ key: "media_retention_days", value: setting });
  const at = (days) => new Date(NOW - days * DAY).toISOString();
  state.tables.messages.push(
    { id: "old", conversation_id: "c1", direction: "in", body: "คำบรรยาย", media_type: "image", media_path: "old.jpg", media_preview_path: "old_p.jpg", created_at: at(91) },
    { id: "new", conversation_id: "c1", direction: "in", body: "", media_type: "image", media_path: "new.jpg", media_preview_path: "new_p.jpg", created_at: at(89) },
    { id: "text", conversation_id: "c1", direction: "in", body: "ข้อความ", media_path: null, created_at: at(500) },
  );
  state.files[CHAT_BUCKET] = new Map(["old.jpg", "old_p.jpg", "new.jpg", "new_p.jpg"].map((p) => [p, { data: Buffer.alloc(1) }]));
  state.files[QUICK_BUCKET] = new Map([["q.jpg", { data: Buffer.alloc(1) }]]);
  state.tables.quick_media = [{ id: "q1", path: "q.jpg", preview_path: "q.jpg", created_at: at(900) }];
}

test("ลบรูปเกิน 90 วัน (ค่าเริ่มต้น): ข้อความยังอยู่ และไม่แตะ quick_media", async () => {
  retentionData();
  assert.equal(await purgeExpiredMedia(NOW), 1);
  const old = msgRow("old");
  assert.equal(old.body, "คำบรรยาย");
  assert.equal(old.media_path, null);
  assert.equal(old.media_preview_path, null);
  assert.ok(old.media_deleted_at);
  assert.equal(msgRow("new").media_path, "new.jpg");
  assert.deepEqual([...state.files[CHAT_BUCKET].keys()], ["new.jpg", "new_p.jpg"]);
  assert.equal(state.files[QUICK_BUCKET].size, 1);
  assert.equal(state.tables.quick_media.length, 1);
  assert.equal(await purgeExpiredMedia(NOW), 0, "รอบถัดไปไม่ลบซ้ำ");
});

test("ตั้งค่า N วันได้", async () => {
  retentionData(30);
  assert.equal(await purgeExpiredMedia(NOW), 2);
});

for (const bad of [0, -5, "abc", null]) {
  test(`ค่าตั้งเสีย (${bad}) ใช้ 90 วัน ไม่ลบรูปทั้งหมด`, async () => {
    retentionData(bad);
    assert.equal(await purgeExpiredMedia(NOW), 1);
  });
}

// ---- widget ----
function widgetEl() {
  const node = {
    style: {}, children: [], className: "", textContent: "", value: "", scrollHeight: 0, _q: {}, parentNode: null, files: null,
    get nextSibling() { const s = node.parentNode?.children ?? []; return s[s.indexOf(node) + 1] ?? null; },
    appendChild(c) { c.parentNode = node; node.children.push(c); return c; },
    insertBefore(c) { return node.appendChild(c); },
    removeChild(c) { node.children.splice(node.children.indexOf(c), 1); return c; },
    querySelector(sel) { return (node._q[sel] ??= widgetEl()); },
    addEventListener() {}, focus() {}, click() {},
  };
  return node;
}
function loadWidget({ start = { status: 200, json: { path: "uploads/web-x", url: "https://storage.test/put" } }, finish = 200, server = { messages: [] }, put = 200 } = {}) {
  const body = widgetEl(), posts = [], puts = [], opened = [];
  const sandbox = {
    document: {
      currentScript: { src: "https://docdesk.example/widget.js" }, documentElement: { lang: "th" }, head: widgetEl(), body,
      hidden: false, addEventListener() {}, createElement: widgetEl,
    },
    location: { href: "https://happiwellclinic.com/" },
    localStorage: { getItem: () => SESSION, setItem() {} },
    crypto: globalThis.crypto, URL, encodeURIComponent, setTimeout: () => 0, clearTimeout() {},
    fetch: async (url, init) => {
      if (String(url).endsWith("/seen")) return { status: 200, ok: true };
      if (String(url).endsWith("/upload")) {
        const b = JSON.parse(init.body);
        posts.push(b);
        if (b.path) return { status: finish, ok: finish < 400 };
        return { status: start.status, ok: start.status < 400, json: async () => start.json };
      }
      if (init?.method === "PUT") { puts.push({ url, type: init.headers["Content-Type"] }); return { status: put, ok: put < 400 }; }
      return { status: 200, ok: true, json: async () => server };
    },
  };
  sandbox.window = sandbox;
  sandbox.open = (...a) => opened.push(a);
  vm.runInNewContext(readFileSync("public/widget.js", "utf8"), sandbox);
  const panel = body.children[1];
  const list = panel.querySelector("#dd-list");
  const fileInput = panel.querySelector("#dd-form").querySelector("#dd-file");
  const pick = async (file) => {
    fileInput.files = [file];
    fileInput.onchange();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { list, pick, posts, puts, opened };
}
const widgetTexts = (w) => w.list.children.map((c) => c.textContent);
const tick = () => new Promise((r) => setImmediate(r));

test("widget ส่งรูป: ขอช่อง → อัปโหลดตรง → แจ้ง server", async () => {
  const w = loadWidget();
  await w.pick({ size: 1000, type: "image/jpeg" });
  assert.deepEqual(w.posts, [{ session: SESSION }, { session: SESSION, path: "uploads/web-x" }]);
  assert.deepEqual(w.puts, [{ url: "https://storage.test/put", type: "image/jpeg" }]);
});

test("widget รูปเกิน 5MB: เตือนโดยไม่เรียก server", async () => {
  const w = loadWidget();
  await w.pick({ size: 5 * 1024 * 1024 + 1, type: "image/jpeg" });
  assert.equal(w.posts.length, 0);
  assert.ok(widgetTexts(w).includes("รูปต้องไม่เกิน 5MB"));
});

test("widget ส่งรูปเกิน rate limit: เตือน ไม่อัปโหลด", async () => {
  const w = loadWidget({ start: { status: 429 } });
  await w.pick({ size: 1000, type: "image/jpeg" });
  assert.equal(w.puts.length, 0);
  assert.ok(widgetTexts(w).includes("ส่งเร็วเกินไป กรุณารอสักครู่"));
});

test("widget server ปฏิเสธไฟล์: แจ้งลูกค้า", async () => {
  const w = loadWidget({ finish: 400 });
  await w.pick({ size: 1000, type: "image/jpeg" });
  assert.ok(widgetTexts(w).some((t) => t.includes("ส่งรูปนี้ไม่ได้")));
});

test("widget แสดงรูป preview คลิกเปิดรูปใหญ่ และแสดงรูปที่ถูกลบ", async () => {
  const w = loadWidget({ server: { messages: [
    { id: "1", direction: "out", body: "แผนที่", created_at: "2026-11-01T00:00:00Z", media_url: "https://s/main", preview_url: "https://s/prev" },
    { id: "2", direction: "in", body: "", created_at: "2026-11-01T00:00:01Z", media_deleted: true },
  ] } });
  await tick();
  const [, withImage, removed] = w.list.children;
  const [img, cap] = withImage.children;
  assert.equal(img.src, "https://s/prev");
  assert.equal(cap.textContent, "แผนที่");
  img.onclick();
  assert.deepEqual(w.opened, [["https://s/main", "_blank", "noopener"]]);
  assert.equal(removed.textContent, "รูปถูกลบตามนโยบายเก็บข้อมูล");
});
