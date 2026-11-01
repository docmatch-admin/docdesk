// ทดสอบตัวป้องกัน /api/webchat และ widget: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { clientIp, corsHeaders, hashIp, isAllowedOrigin, WEBCHAT_LIMITS } from "../src/lib/webchat-guard.ts";

test("ค่าเพดานตรงตามที่กำหนด", () => {
  assert.deepEqual(WEBCHAT_LIMITS, { perMinute: 5, perHour: 30, newSessionsPerIpPerHour: 3, aiPerDay: 300 });
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
    appendChild(c) { node.children.push(c); return c; },
    querySelector(sel) { return (node._q[sel] ??= el()); },
    addEventListener() {},
    focus() {},
  };
  return node;
}
function loadWidget(status, lang = "th") {
  const head = el(), body = el();
  const posts = [];
  const created = [];
  const sandbox = {
    document: {
      currentScript: { src: "https://docdesk.example/widget.js" },
      documentElement: { lang },
      head, body,
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
      if (init?.method === "POST") { posts.push(JSON.parse(init.body)); return { status }; }
      return { status: 200, json: async () => ({ messages: [] }) };
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
  return { list, input, send, posts };
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
