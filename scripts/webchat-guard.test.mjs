// ทดสอบตัวป้องกัน /api/webchat และ widget: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { admitWebchatImage, clientIp, corsHeaders, hashIp, isAllowedOrigin, WEBCHAT_LIMITS } from "../src/lib/webchat-guard.ts";

test("ค่าเพดานตรงตามที่กำหนด", () => {
  assert.deepEqual(WEBCHAT_LIMITS, { perMinute: 5, perHour: 30, newSessionsPerIpPerHour: 3, aiPerDay: 300, imagesPerDay: 100 });
});

for (const origin of [
  "https://happiwellclinic.com",
  "https://www.happiwellclinic.com",
  "http://localhost:3000",
  "http://localhost",
]) {
  test(`รับ Origin: ${origin}`, () => {
    assert.equal(isAllowedOrigin(origin), true);
    assert.equal(corsHeaders(origin)["Access-Control-Allow-Origin"], origin);
  });
}

for (const origin of [
  null,
  "",
  "null",
  "https://evil.com",
  "https://happiwellclinic.com.evil.com",
  "https://evilhappiwellclinic.com",
  "https://shop.happiwellclinic.com",
  "http://happiwellclinic.com",
  "https://localhost.evil.com",
  "https://happiwellclinic.com/path",
]) {
  test(`ไม่รับ Origin: ${origin}`, () => {
    assert.equal(isAllowedOrigin(origin), false);
    assert.equal(corsHeaders(origin)["Access-Control-Allow-Origin"], undefined);
  });
}

test("ใช้ IP ตัวแรกจาก x-forwarded-for", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientIp(new Headers()), "unknown");
});

test("รูปใช้ RPC และเพดานของรูป ไม่ใช้เพดาน AI", async () => {
  let call;
  const db = { rpc: async (fn, args) => { call = { fn, args }; return { data: { allowed: true, reason: null } }; } };
  assert.deepEqual(await admitWebchatImage(db, "s1", "h1"), { allowed: true, reason: null });
  assert.equal(call.fn, "webchat_admit_image");
  assert.equal(call.args.p_images_per_day, 100);
  assert.equal(call.args.p_per_minute, 5);
  assert.equal(call.args.p_per_hour, 30);
  assert.equal(call.args.p_new_sessions_per_hour, 3);
  assert.equal("p_ai_per_day" in call.args, false);
  await assert.rejects(admitWebchatImage({ rpc: async () => ({ error: new Error("down") }) }, "s1", "h1"), /down/);
});

test("hash IP ไม่เก็บ IP จริง และขึ้นกับ secret", () => {
  const a = hashIp("1.2.3.4", "secret-a");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes("1.2.3.4"));
  assert.equal(a, hashIp("1.2.3.4", "secret-a"));
  assert.notEqual(a, hashIp("1.2.3.5", "secret-a"));
  assert.notEqual(a, hashIp("1.2.3.4", "secret-b"));
  assert.throws(() => hashIp("1.2.3.4", ""));
});

// ---- รัน public/widget.js จริงบน DOM จำลอง ----
function el() {
  const node = {
    style: {}, children: [], className: "", textContent: "", value: "", scrollHeight: 0, _q: {},
    parentNode: null,
    get nextSibling() {
      const sibs = node.parentNode?.children ?? [];
      return sibs[sibs.indexOf(node) + 1] ?? null;
    },
    appendChild(c) { return node.insertBefore(c, null); },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = node;
      node.children.splice(ref ? node.children.indexOf(ref) : node.children.length, 0, c);
      return c;
    },
    removeChild(c) { node.children.splice(node.children.indexOf(c), 1); c.parentNode = null; return c; },
    querySelector(sel) { return (node._q[sel] ??= el()); },
    addEventListener() {},
    focus() {},
  };
  return node;
}
function loadWidget(status, lang = "th", server = { messages: [], clinic_read_at: null }) {
  const head = el(), body = el();
  const posts = [];
  const seen = [];
  const created = [];
  const docListeners = {};
  const sandbox = {
    document: {
      currentScript: { src: "https://docdesk.example/widget.js" },
      documentElement: { lang },
      head, body,
      hidden: false,
      addEventListener(type, fn) { docListeners[type] = fn; },
      createElement() { const n = el(); created.push(n); return n; },
    },
    location: { href: "https://happiwellclinic.com/" },
    localStorage: { getItem: () => "11111111-1111-4111-8111-111111111111", setItem() {} },
    crypto: globalThis.crypto,
    URL,
    encodeURIComponent,
    setTimeout: () => 0,
    clearTimeout() {},
    fetch: async (url, init) => {
      if (String(url).endsWith("/api/webchat/seen")) { seen.push(JSON.parse(init.body)); return { status: 200 }; }
      if (init?.method === "POST") { posts.push(JSON.parse(init.body)); return { status }; }
      return { status: 200, json: async () => server };
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(readFileSync("public/widget.js", "utf8"), sandbox);
  const panel = body.children[1];
  const list = panel.querySelector("#dd-list");
  const form = panel.querySelector("#dd-form");
  const input = form.querySelector("textarea");
  const send = async (text) => {
    input.value = text;
    form.onsubmit({ preventDefault() {} });
    await new Promise((r) => setImmediate(r));
  };
  const tick = () => new Promise((r) => setImmediate(r));
  const openPanel = async () => { body.children[0].onclick(); await tick(); };
  const closePanel = async () => { body.children[0].onclick(); await tick(); };
  const setHidden = async (v) => {
    sandbox.document.hidden = v;
    docListeners.visibilitychange();
    await tick();
  };
  return { list, input, send, posts, seen, server, tick, openPanel, closePanel, setHidden };
}
const texts = (list) => list.children.map((c) => c.textContent);

test("widget ได้ 429: แสดงข้อความเตือน และคืนข้อความที่พิมพ์ไว้", async () => {
  const w = loadWidget(429);
  await w.send("สวัสดีค่ะ");
  assert.equal(w.posts.length, 1);
  assert.ok(texts(w.list).includes("ส่งเร็วเกินไป กรุณารอสักครู่"));
  assert.equal(w.input.value, "สวัสดีค่ะ");
});

test("widget หน้าอังกฤษได้ 429: แสดงข้อความภาษาอังกฤษ", async () => {
  const w = loadWidget(429, "en");
  await w.send("hello");
  assert.ok(texts(w.list).some((t) => /too quickly/.test(t)));
});

test("widget ได้ 200: ไม่แสดงข้อความเตือน และล้างช่องพิมพ์", async () => {
  const w = loadWidget(200);
  await w.send("สวัสดีค่ะ");
  assert.ok(!texts(w.list).includes("ส่งเร็วเกินไป กรุณารอสักครู่"));
  assert.equal(w.input.value, "");
});

// ---- สถานะ "อ่านแล้ว" ----
const T1 = "2026-11-01T10:00:00.123456+00:00";
const T2 = "2026-11-01T10:00:05.000000+00:00";
const T3 = "2026-11-01T10:00:10.000000+00:00";
const msg = (id, direction, created_at) => ({ id, direction, body: id, created_at });

test("widget: แสดงอ่านแล้วใต้ข้อความล่าสุดของลูกค้า เมื่อคลินิกอ่านหลังข้อความนั้น", async () => {
  const w = loadWidget(200, "th", { messages: [msg("q1", "in", T1), msg("a1", "out", T2)], clinic_read_at: T1 });
  await w.tick();
  assert.deepEqual(texts(w.list).slice(1), ["q1", "อ่านแล้ว", "a1"]);
});

test("widget: คลินิกยังไม่อ่าน ไม่แสดงอ่านแล้ว", async () => {
  const w = loadWidget(200, "th", { messages: [msg("q1", "in", T1)], clinic_read_at: null });
  await w.tick();
  assert.ok(!texts(w.list).includes("อ่านแล้ว"));
});

test("widget: ลูกค้าส่งข้อความใหม่ ป้ายอ่านแล้วหายจนกว่าคลินิกจะอ่านอีกครั้ง", async () => {
  const w = loadWidget(200, "th", { messages: [msg("q1", "in", T1)], clinic_read_at: T1 });
  await w.tick();
  assert.ok(texts(w.list).includes("อ่านแล้ว"));

  w.server.messages = [msg("q2", "in", T2)];
  await w.send("q2");
  assert.ok(!texts(w.list).includes("อ่านแล้ว"));

  w.server.clinic_read_at = T3;
  await w.send("ping");
  assert.deepEqual(texts(w.list).slice(1), ["q1", "q2", "อ่านแล้ว"]);
});

test("widget: แจ้งเห็นข้อความเมื่อเปิดหน้าต่างเท่านั้น และไม่แจ้งซ้ำ", async () => {
  const w = loadWidget(200, "th", { messages: [msg("a1", "out", T1)], clinic_read_at: null });
  await w.tick();
  assert.equal(w.seen.length, 0);

  await w.openPanel();
  assert.deepEqual(w.seen.map((s) => s.upTo), [T1]);

  await w.closePanel();
  await w.openPanel();
  assert.equal(w.seen.length, 1);
});

test("widget: แท็บถูกซ่อนยังไม่นับว่าเห็น แจ้งเมื่อกลับมาที่แท็บ", async () => {
  const w = loadWidget(200, "th", { messages: [msg("a1", "out", T1)], clinic_read_at: null });
  await w.tick();
  await w.setHidden(true);
  await w.openPanel();
  assert.equal(w.seen.length, 0);
  await w.setHidden(false);
  assert.deepEqual(w.seen.map((s) => s.upTo), [T1]);
});

test("widget: ข้อความทักทายในเครื่องไม่ถูกแจ้งว่าเห็น", async () => {
  const w = loadWidget(200);
  await w.tick();
  await w.openPanel();
  assert.equal(w.seen.length, 0);
});
