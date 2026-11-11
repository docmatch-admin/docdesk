// แอปมือถือ (PWA): manifest ติดตั้งได้ · service worker ไม่ cache ข้อมูลคนไข้ · แถบเมนูล่างบนมือถือ
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("manifest: ติดตั้งได้ (ชื่อ start_url standalone ไอคอน 192/512 + maskable) ไฟล์ไอคอนมีจริง", () => {
  const m = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  assert.equal(m.lang, "th");
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  for (const s of ["192x192:any", "512x512:any", "512x512:maskable"]) assert.ok(sizes.includes(s), s);
  for (const i of m.icons) assert.ok(existsSync(`public${i.src}`), i.src);
  assert.ok(existsSync("public/icons/apple-touch-icon.png"));
  assert.ok(existsSync("public/offline.html"));
});

test("service worker: cache เฉพาะหน้าออฟไลน์+ไอคอน ไม่ cache หน้า/ข้อมูล · ออฟไลน์ขึ้นหน้าออฟไลน์ · push เดิมยังทำงาน", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  assert.match(sw, /const SHELL = \["\/offline\.html", "\/icons\/icon-192\.png", "\/icons\/badge-96\.png"\]/);
  assert.match(sw, /req\.mode !== "navigate"\) return;/, "ไม่แตะคำขอ API/ข้อมูล");
  assert.doesNotMatch(sw, /cache\.put|c\.put\(/, "ไม่เก็บ response ลง cache");
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /addEventListener\("notificationclick"/);
});

test("layout: ลงทะเบียน SW ทุกหน้า · meta iPhone · แถบเมนูล่าง + ปุ่มติดตั้งแอป", () => {
  const root = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(root, /<RegisterSW \/>/);
  assert.match(root, /appleWebApp: \{ capable: true/);
  assert.match(root, /viewportFit: "cover"/);
  const staff = readFileSync("src/app/(staff)/layout.tsx", "utf8");
  assert.match(staff, /<MobileNav chatStaff=\{chatStaff\} calls=\{calls\} \/>/);
  assert.match(staff, /<InstallApp \/>/);
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.staff-root:has\(\.inbox\.has-chat\) \.mobile-tabbar \{ display: none; \}/, "ในห้องแชทซ่อนแถบล่าง");
  assert.match(css, /html\[data-mnav-open\] \.nav \{/, "เมนูเต็มใช้ .nav ตัวเดิม ไม่ render ซ้ำ");
  const badge = readFileSync("src/app/(staff)/mobile-nav.tsx", "utf8");
  assert.match(badge, /channel="appointment-badge-mobile"/, "badge มือถือใช้ realtime channel แยก ไม่ชนกับเมนูซ้าย");
});
