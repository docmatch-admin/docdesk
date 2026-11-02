// ทดสอบหน้านโยบายสาธารณะ: npm test
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PAGES = { "/privacy": "privacy", "/terms": "terms", "/data-deletion": "data-deletion" };
const html = (name) => readFileSync(`public/legal/${name}.html`, "utf8");

test("rewrite 3 path ไปที่ไฟล์ static", async () => {
  const { default: config } = await import("../next.config.ts");
  const rules = await config.rewrites();
  for (const [source, name] of Object.entries(PAGES)) {
    assert.ok(rules.some((r) => r.source === source && r.destination === `/legal/${name}.html`), source);
    assert.ok(existsSync(`public/legal/${name}.html`), name);
  }
});

test("ไม่อยู่ในกลุ่มหน้าเจ้าหน้าที่ที่ต้องล็อกอิน และไม่มี middleware", () => {
  for (const p of ["src/app/privacy", "src/app/terms", "src/app/data-deletion", "src/middleware.ts", "src/proxy.ts", "middleware.ts", "proxy.ts"]) {
    assert.equal(existsSync(p), false, p);
  }
});

test("ลิงก์ภายในชี้ไปที่ path ของ DocDesk", () => {
  for (const name of Object.values(PAGES)) {
    const page = html(name);
    assert.doesNotMatch(page, /chat-privacy|chat-terms/);
    for (const [, href] of page.matchAll(/href="([^"]+)"/g)) {
      assert.ok(href.startsWith("mailto:") || Object.keys(PAGES).includes(href), `${name}: ${href}`);
    }
  }
});

test("นโยบายระบุว่าคลินิกเป็นผู้ควบคุมข้อมูล ทั้งไทยและอังกฤษ", () => {
  const page = html("privacy");
  assert.match(page, /DocDesk เป็นระบบที่คลินิกใช้รับข้อความ โดยคลินิกเป็นผู้ควบคุมข้อมูล \(data controller\)/);
  assert.match(page, /DocDesk is the system the clinic uses to receive messages\. The clinic is the data controller\./);
});

test("หน้า static ไม่มีสคริปต์", () => {
  for (const name of Object.values(PAGES)) assert.doesNotMatch(html(name), /<script/i);
});
