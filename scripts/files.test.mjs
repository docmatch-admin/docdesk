// ทดสอบการรับ-ส่งไฟล์ PDF ทุกช่องทาง: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import vm from "node:vm";
import { fake } from "./fakes/hooks.mjs";

const { reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { detectDocType, fileNameFromUrl, FILE_LINK_DAYS, formatFileSize, isPdfName, sanitizeFileName } = await import("../src/lib/files.ts");
const { buildOutMediaUrl, verifyOutMediaSignature } = await import("../src/lib/media-url.ts");
const { attachWidgetMedia, CHAT_BUCKET, consumeUploadAny, ingestInboundFile } = await import("../src/lib/media-store.ts");
const { lineFileCard } = await import("../src/lib/channels/line.ts");
const { parseMetaWebhook } = await import("../src/lib/channels/meta.ts");
const { sendMediaReply, storeIncoming } = await import("../src/lib/pipeline.ts");
const outRoute = await import("../src/app/api/media/out/[id]/[name]/route.ts");

process.env.MEDIA_URL_SECRET = "test-secret";
process.env.LINE_CHANNEL_ACCESS_TOKEN = "line-token";
process.env.META_PAGE_ACCESS_TOKEN = "page-token";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(2000, 65), Buffer.from("\n%%EOF")]);
const DAY_MS = 86_400_000;
const params = (url) => { const u = new URL(url); return { v: u.searchParams.get("v"), exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") }; };

// ---- ตัวช่วย ----
test("detectDocType: ดูจากเนื้อไฟล์ ไม่ใช่นามสกุล", () => {
  assert.equal(detectDocType(PDF), "pdf");
  assert.equal(detectDocType(Buffer.concat([Buffer.alloc(100, 32), PDF])), "pdf", "มีข้อมูลก่อนหัวไฟล์ได้");
  assert.equal(detectDocType(Buffer.from("MZ\x90\x00 not a pdf")), null);
  assert.equal(detectDocType(Buffer.concat([Buffer.alloc(2000, 32), PDF])), null, "หัวไฟล์ต้องอยู่ใน 1KB แรก");
  assert.equal(detectDocType(new Uint8Array([0x25, 0x50, 0x44, 0x46])), null, "สั้นเกิน");
});

test("sanitizeFileName / isPdfName / formatFileSize / fileNameFromUrl", () => {
  assert.equal(sanitizeFileName("C:\\Users\\a\\ผลแล็บ.pdf"), "ผลแล็บ.pdf");
  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd.pdf");
  assert.equal(sanitizeFileName('ใบ"เสนอ<ราคา>.PDF'), "ใบเสนอราคา.PDF");
  assert.equal(sanitizeFileName("  "), "เอกสาร.pdf");
  assert.equal(sanitizeFileName(null), "เอกสาร.pdf");
  assert.ok(sanitizeFileName(`${"ก".repeat(300)}.pdf`).length <= 120);
  assert.ok(sanitizeFileName(`${"ก".repeat(300)}.pdf`).endsWith(".pdf"));
  assert.equal(isPdfName("a.PDF"), true);
  assert.equal(isPdfName("a.docx"), false);
  assert.equal(formatFileSize(500), "1 KB");
  assert.equal(formatFileSize(150 * 1024), "150 KB");
  assert.equal(formatFileSize(3.25 * 1024 * 1024), "3.3 MB");
  assert.equal(formatFileSize(null), "");
  assert.equal(fileNameFromUrl("https://cdn.fbsbx.com/v/t59/%E0%B8%9C%E0%B8%A5.pdf?_nc=1"), "ผล.pdf");
  assert.equal(fileNameFromUrl("not a url"), "เอกสาร.pdf");
});

// ---- LINE: การ์ดไฟล์ ----
test("LINE การ์ดไฟล์: ปุ่มเปิดไฟล์ด้วยลิงก์ ชื่อ ขนาด และวันหมดอายุ", () => {
  const card = lineFileCard({ url: "https://app.test/api/media/out/m1/a.pdf?v=file", name: "ผลแล็บ.pdf", sizeText: formatFileSize(150 * 1024), expiresAt: new Date("2026-11-11T05:00:00Z") });
  assert.equal(card.type, "flex");
  assert.equal(card.altText, "📄 ผลแล็บ.pdf");
  const [button] = card.contents.footer.contents;
  assert.deepEqual(button.action, { type: "uri", label: "เปิดไฟล์", uri: "https://app.test/api/media/out/m1/a.pdf?v=file" });
  const texts = card.contents.body.contents.map((c) => c.text);
  assert.ok(texts.includes("ผลแล็บ.pdf"));
  assert.match(texts.at(-1), /150 KB · เปิดได้ถึง 11 พ\.ย\. 69/);
  const en = lineFileCard({ url: "https://x", name: "a.pdf", expiresAt: new Date("2026-11-11T05:00:00Z"), language: "en" });
  assert.equal(en.contents.footer.contents[0].action.label, "Open file");
  assert.match(en.contents.body.contents.at(-1).text, /^Available until 11 Nov 2026$/);
});

// ---- Meta: รับไฟล์ ----
test("Meta webhook: ไฟล์แนบได้ลิงก์และชื่อไฟล์ ไฟล์แนบอื่นยังเป็นข้อความแจ้ง", () => {
  const body = (attachments) => ({ object: "page", entry: [{ id: "PAGE", messaging: [{ sender: { id: "U" }, message: { mid: "m1", attachments } }] }] });
  const [f] = parseMetaWebhook(body([{ type: "file", payload: { url: "https://cdn.fbsbx.com/x/report.pdf?a=1" } }]));
  assert.equal(f.fileUrl, "https://cdn.fbsbx.com/x/report.pdf?a=1");
  assert.equal(fileNameFromUrl(f.fileUrl), "report.pdf");
  assert.equal(f.text, "");
  const [v] = parseMetaWebhook(body([{ type: "video", payload: { url: "https://cdn/v.mp4" } }]));
  assert.equal(v.fileUrl, undefined);
  assert.match(v.text, /ลูกค้าส่งวิดีโอ/);
  const two = parseMetaWebhook(body([{ type: "file", payload: { url: "https://c/a.pdf" } }, { type: "file", payload: { url: "https://c/b.pdf" } }]));
  assert.deepEqual(two.map((x) => x.messageId), ["m1", "m1:1"]);
});

// ---- เก็บไฟล์ ----
function setup(type = "web") {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "assist" }],
    channels: [{ id: "ch", type, name: type, ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: [], tag_rules: [], tag_events: [], reply_examples: [],
  });
  state.files[CHAT_BUCKET] = new Map();
}
beforeEach(() => setup());
const conv = () => state.tables.conversations[0];
const msgRow = (id) => state.tables.messages.find((m) => m.id === id);
const code = (c) => (e) => e?.code === c;

test("consumeUploadAny: PDF เก็บเป็นไฟล์ รูปยังผ่านทางเดิม ไฟล์อื่นถูกปฏิเสธ และไฟล์พักถูกลบเสมอ", async () => {
  state.files[CHAT_BUCKET].set("uploads/staff-1", { data: PDF });
  const up = await consumeUploadAny("uploads/staff-1", CHAT_BUCKET, { maxImage: 1000, maxFile: 10_000, fileName: "ผลแล็บ.pdf" });
  assert.equal(up.kind, "file");
  assert.equal(up.file.name, "ผลแล็บ.pdf");
  assert.equal(up.file.size, PDF.length);
  assert.match(up.file.path, /^\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/);
  assert.equal(state.files[CHAT_BUCKET].has("uploads/staff-1"), false);

  state.files[CHAT_BUCKET].set("uploads/staff-2", { data: PDF });
  await assert.rejects(consumeUploadAny("uploads/staff-2", CHAT_BUCKET, { maxImage: 1000, maxFile: 100 }), code("too_large"));
  assert.equal(state.files[CHAT_BUCKET].has("uploads/staff-2"), false);

  state.files[CHAT_BUCKET].set("uploads/staff-3", { data: Buffer.from("PK\x03\x04 fake docx") });
  await assert.rejects(consumeUploadAny("uploads/staff-3", CHAT_BUCKET, { maxImage: 1000, maxFile: 10_000 }), code("unsupported"));
  assert.equal(state.files[CHAT_BUCKET].has("uploads/staff-3"), false);
});

test("ลูกค้าส่ง PDF: การ์ดไฟล์ในแชท ต้องให้คนดู ดาวน์โหลดสำเร็จเก็บไฟล์ ไม่ใช่ PDF แจ้งให้ไปดูในแอป", async () => {
  const s = await storeIncoming({ channelType: "web", externalId: "11111111-1111-4111-8111-111111111111", text: "", file: { name: "ผลแล็บ.pdf", size: PDF.length } });
  const row = msgRow(s.messageId);
  assert.equal(row.media_type, "file");
  assert.equal(row.file_name, "ผลแล็บ.pdf");
  assert.equal(row.body_th, null, "ไม่แปล");
  assert.equal(conv().needs_human, true);
  assert.equal(conv().last_message_preview, "[ไฟล์] ผลแล็บ.pdf");

  await ingestInboundFile(s.messageId, async () => PDF, "ผลแล็บ.pdf");
  assert.match(row.media_path, /\.pdf$/);
  assert.equal(row.file_size, PDF.length);
  assert.ok(state.files[CHAT_BUCKET].has(row.media_path));

  const s2 = await storeIncoming({ channelType: "web", externalId: "11111111-1111-4111-8111-111111111111", text: "", file: { name: "virus.pdf" } });
  await ingestInboundFile(s2.messageId, async () => Buffer.from("MZ not a pdf"), "virus.pdf", "[เปิดดูในแอป]");
  assert.equal(msgRow(s2.messageId).media_type, null);
  assert.equal(msgRow(s2.messageId).body, "[เปิดดูในแอป]");
});

// ---- ส่งไฟล์ ----
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function mockFetch() {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ message_id: "mid.1" }), { status: 200 });
  };
  return sent;
}
function staffChat(type) {
  setup(type);
  state.tables.contacts.push({ id: "ct", channel_id: "ch", external_id: "U1", language: "th" });
  state.tables.conversations.push({ id: "c1", contact_id: "ct", channel_id: "ch", needs_human: true, status: "open", tags: [] });
  state.tables.messages.push({ id: "in1", conversation_id: "c1", direction: "in", sender_type: "customer", body: "ขอผลแล็บ", created_at: new Date(Date.now() - 1000).toISOString() });
  state.files[CHAT_BUCKET].set("uploads/staff-1", { data: PDF });
}
const sendPdf = (caption = "") => sendMediaReply({ conversationId: "c1", senderId: "s1", origin: "https://app.test", uploadPath: "uploads/staff-1", fileName: "ผลแล็บ.pdf", captionTh: caption });

test("ส่ง PDF ทาง LINE: การ์ดไฟล์ ลิงก์มีชื่อไฟล์ ลายเซ็นใช้ได้ 7 วัน และ caption ตามมา", async () => {
  staffChat("line");
  const sent = mockFetch();
  const before = Date.now();
  const { messageId } = await sendPdf("ผลตรวจค่ะ");
  const [card, caption] = sent[0].body.messages;
  assert.equal(card.type, "flex");
  assert.deepEqual(caption, { type: "text", text: "ผลตรวจค่ะ" });
  const uri = card.contents.footer.contents[0].action.uri;
  assert.equal(new URL(uri).pathname, `/api/media/out/${messageId}/${encodeURIComponent("ผลแล็บ.pdf")}`);
  assert.equal(params(uri).v, "file");
  assert.equal(verifyOutMediaSignature(messageId, params(uri)), true);
  const days = (Number(params(uri).exp) * 1000 - before) / DAY_MS;
  assert.ok(Math.abs(days - FILE_LINK_DAYS) < 0.01, String(days));
  const row = msgRow(messageId);
  assert.deepEqual([row.media_type, row.file_name, row.file_size, row.media_preview_path ?? null], ["file", "ผลแล็บ.pdf", PDF.length, null]);
  assert.equal(conv().last_message_preview, "[ไฟล์] ผลแล็บ.pdf ผลตรวจค่ะ");
  assert.match(card.contents.body.contents.at(-1).text, /^2 KB · เปิดได้ถึง /);
  assert.equal(conv().needs_human, false);
});

for (const type of ["facebook", "instagram"]) {
  test(`ส่ง PDF ทาง ${type}: attachment type file ด้วยลิงก์ที่มีลายเซ็น`, async () => {
    staffChat(type);
    const sent = mockFetch();
    const { messageId } = await sendPdf();
    assert.equal(sent.length, 1);
    const att = sent[0].body.message.attachment;
    assert.equal(att.type, "file");
    assert.equal(params(att.payload.url).v, "file");
    assert.equal(verifyOutMediaSignature(messageId, params(att.payload.url)), true);
    assert.equal(msgRow(messageId).external_id, "mid.1");
  });
}

test("ส่ง PDF ทางเว็บ: ไม่เรียกแพลตฟอร์ม เก็บเป็นการ์ดไฟล์ให้ widget", async () => {
  staffChat("web");
  const sent = mockFetch();
  const { messageId } = await sendPdf();
  assert.equal(sent.length, 0);
  assert.equal(msgRow(messageId).media_type, "file");
});

test("ส่ง PDF ไม่สำเร็จ: ลบแถวข้อความและไฟล์", async () => {
  staffChat("line");
  globalThis.fetch = async () => new Response("down", { status: 500 });
  await assert.rejects(sendPdf(), /LINE push failed/);
  assert.equal(state.tables.messages.filter((m) => m.direction === "out").length, 0);
  assert.equal([...state.files[CHAT_BUCKET].keys()].length, 0);
});

// ---- ลิงก์เปิดไฟล์ ----
async function serve(id, url) {
  const res = await outRoute.GET(new Request(url), { params: Promise.resolve({ id, name: "x.pdf" }) });
  return { res, body: res.ok ? Buffer.from(await res.arrayBuffer()) : null };
}

test("ลิงก์ไฟล์: เปิดเป็น PDF พร้อมชื่อไฟล์ ลายเซ็นรูปใช้เปิดไฟล์ไม่ได้ และหมดอายุแล้วเปิดไม่ได้", async () => {
  state.files[CHAT_BUCKET].set("2026-11/f.pdf", { data: PDF });
  state.tables.messages = [
    { id: "f1", direction: "out", media_type: "file", media_path: "2026-11/f.pdf", file_name: "ผลแล็บ.pdf" },
    { id: "i1", direction: "out", media_type: "image", media_path: "2026-11/f.pdf", media_preview_path: "2026-11/f.pdf" },
    { id: "in", direction: "in", media_type: "file", media_path: "2026-11/f.pdf", file_name: "ลูกค้า.pdf" },
  ];
  const ok = await serve("f1", buildOutMediaUrl("https://app.test", "f1", "file", { ttlDays: 7, fileName: "ผลแล็บ.pdf" }));
  assert.equal(ok.res.status, 200);
  assert.equal(ok.res.headers.get("content-type"), "application/pdf");
  assert.match(ok.res.headers.get("content-disposition"), /filename\*=UTF-8''%E0%B8%9C/);
  assert.equal(ok.res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(ok.body, PDF);

  assert.equal((await serve("f1", buildOutMediaUrl("https://app.test", "f1", "main"))).res.status, 404, "ลายเซ็นรูปเปิดไฟล์ไม่ได้");
  assert.equal((await serve("i1", buildOutMediaUrl("https://app.test", "i1", "file"))).res.status, 404, "ลายเซ็นไฟล์เปิดรูปไม่ได้");
  assert.equal((await serve("in", buildOutMediaUrl("https://app.test", "in", "file"))).res.status, 404, "ไฟล์ขาเข้าไม่เปิดสาธารณะ");
  const expired = buildOutMediaUrl("https://app.test", "f1", "file", { ttlDays: 7, now: Date.now() - 8 * DAY_MS });
  assert.equal((await serve("f1", expired)).res.status, 403);
});

test("attachWidgetMedia: ไฟล์ได้ชื่อ ขนาด และลิงก์ชั่วคราว ไม่มี preview", async () => {
  const out = await attachWidgetMedia([
    { id: "f", direction: "out", body: "ผลตรวจค่ะ", created_at: "t", media_type: "file", media_path: "a.pdf", media_preview_path: null, file_name: "ผล.pdf", file_size: 1234 },
    { id: "g", direction: "in", body: "", created_at: "t", media_type: "file", media_path: null, file_name: "รอโหลด.pdf" },
  ]);
  assert.match(out[0].media_url, /signed\/chat-media\/a\.pdf$/);
  assert.equal(out[0].file_name, "ผล.pdf");
  assert.equal(out[0].file_size, 1234);
  assert.equal(out[0].preview_url, undefined);
  assert.equal(out[1].media_url, undefined);
  assert.equal("media_path" in out[0], false);
});

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
function loadWidget({ finish = 200, server = { messages: [] } } = {}) {
  const body = widgetEl(), posts = [];
  const sandbox = {
    document: { currentScript: { src: "https://docdesk.example/widget.js" }, documentElement: { lang: "th" }, head: widgetEl(), body, hidden: false, addEventListener() {}, createElement: widgetEl },
    location: { href: "https://happiwellclinic.com/" },
    localStorage: { getItem: () => "11111111-1111-4111-8111-111111111111", setItem() {} },
    crypto: globalThis.crypto, URL, encodeURIComponent, setTimeout: () => 0, clearTimeout() {},
    fetch: async (url, init) => {
      if (String(url).endsWith("/seen")) return { status: 200, ok: true };
      if (String(url).endsWith("/upload")) {
        const b = JSON.parse(init.body);
        posts.push(b);
        if (b.path) return { status: finish, ok: finish < 400 };
        return { status: 200, ok: true, json: async () => ({ path: "uploads/web-x", url: "https://storage.test/put" }) };
      }
      if (init?.method === "PUT") return { status: 200, ok: true };
      return { status: 200, ok: true, json: async () => server };
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync("public/widget.js", "utf8"), sandbox);
  const panel = body.children[1];
  const list = panel.querySelector("#dd-list");
  const fileInput = panel.querySelector("#dd-form").querySelector("#dd-file");
  const pick = async (file) => {
    fileInput.files = [file];
    fileInput.onchange();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { list, pick, posts };
}
const texts = (w) => w.list.children.map((c) => c.textContent);

test("widget ส่ง PDF: แจ้งชื่อไฟล์ตอนอัปโหลดเสร็จ / เกิน 10MB เตือน / server ปฏิเสธบอกให้ใช้ PDF", async () => {
  const w = loadWidget();
  await w.pick({ size: 1000, type: "application/pdf", name: "ใบส่งตัว.pdf" });
  assert.deepEqual(w.posts.at(-1), { session: "11111111-1111-4111-8111-111111111111", path: "uploads/web-x", name: "ใบส่งตัว.pdf" });

  const big = loadWidget();
  await big.pick({ size: 10 * 1024 * 1024 + 1, type: "application/pdf", name: "a.pdf" });
  assert.equal(big.posts.length, 0);
  assert.ok(texts(big).includes("ไฟล์ PDF ต้องไม่เกิน 10MB"));

  const bad = loadWidget({ finish: 400 });
  await bad.pick({ size: 1000, type: "", name: "a.pdf" });
  assert.ok(texts(bad).includes("ส่งไฟล์นี้ไม่ได้ กรุณาใช้ไฟล์ PDF"));
});

test("widget แสดงการ์ดไฟล์เป็นลิงก์เปิดไฟล์", async () => {
  const w = loadWidget({ server: { messages: [
    { id: "1", direction: "out", body: "ผลตรวจค่ะ", created_at: "2026-11-01T00:00:00Z", media_url: "https://s/file", file_name: "ผล.pdf", file_size: 2048 },
  ] } });
  await new Promise((r) => setImmediate(r));
  const bubble = w.list.children.find((c) => c.children?.some((x) => x.className === "dd-file"));
  assert.ok(bubble, "มีการ์ดไฟล์");
  const link = bubble.children.find((x) => x.className === "dd-file");
  assert.equal(link.textContent, "📄 ผล.pdf · 2 KB");
  assert.equal(link.href, "https://s/file");
  assert.equal(link.target, "_blank");
  assert.equal(bubble.children.find((x) => x.className === "dd-cap").textContent, "ผลตรวจค่ะ");
});
