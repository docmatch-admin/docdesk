// แอปมือถือ (PWA): manifest ติดตั้งได้ · service worker ไม่ cache ข้อมูลคนไข้ · แถบเมนูล่างบนมือถือ
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("manifest: ติดตั้งได้ (ชื่อ start_url standalone ไอคอน 192/512 + maskable) ไฟล์ไอคอนมีจริง", () => {
  const m = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/start?source=pwa", "เปิดแอปตรงไปที่ app shell ไม่ผ่าน redirect");
  assert.equal(m.id, "/", "id เดิม: แอปที่ติดตั้งแล้วไม่กลายเป็นแอปใหม่");
  assert.equal(m.background_color, "#f4f6fa");
  assert.equal(m.theme_color, "#4a63e0");
  assert.equal(m.lang, "th");
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
  for (const s of ["192x192:any", "512x512:any", "192x192:maskable", "512x512:maskable"]) assert.ok(sizes.includes(s), s);
  for (const i of m.icons) assert.ok(existsSync(`public${i.src}`), i.src);
  assert.ok(existsSync("public/icons/apple-touch-icon.png"));
  assert.ok(existsSync("public/offline.html"));
});

test("service worker (Serwist): precache shell+static+ฟอนต์+ไอคอน cache-first · API/Supabase/หน้าอื่น ไม่ cache · push เดิมยังทำงาน", () => {
  const sw = readFileSync("src/app/sw.ts", "utf8");
  assert.match(sw, /from "serwist"/);
  assert.match(sw, /url\.pathname\.startsWith\("\/api\/"\), handler: new NetworkOnly\(\)/, "API ไม่ cache");
  assert.match(sw, /\.supabase\.co"\), handler: new NetworkOnly\(\)/, "Supabase ไม่ cache");
  assert.match(sw, /request\.mode === "navigate", handler: new NetworkOnly\(\)/, "หน้าอื่นไม่ cache");
  assert.match(sw, /request\.headers\.get\("RSC"\) === "1", handler: new NetworkOnly\(\)/, "RSC payload ไม่ cache");
  assert.doesNotMatch(sw, /NetworkFirst|StaleWhileRevalidate|defaultCache/, "ไม่มีกลยุทธ์ที่เก็บ response ของหน้า/ข้อมูล");
  assert.match(sw, /ignoreURLParametersMatching: \[[^\]]*\/\^source\$\//, "start_url ?source=pwa ใช้ shell ที่ precache");
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  const route = readFileSync("src/app/serwist/[path]/route.ts", "utf8");
  assert.match(route, /\{ url: "\/start", revision \}/);
  assert.match(route, /\.next\/static\/\*\*\/\*\.\{js,css,woff2/);
  assert.doesNotMatch(route, /"public\/\*\*/, "ไม่ precache ทุกไฟล์ใน public");
  assert.ok(!existsSync("public/sw.js"), "ตัวเดิมถูกแทนด้วย /serwist/sw.js");
  const { SW_URL } = { SW_URL: readFileSync("src/lib/sw-url.ts", "utf8").match(/SW_URL = "([^"]+)"/)[1] };
  assert.equal(SW_URL, "/serwist/sw.js");
  for (const f of ["src/app/register-sw.tsx", "src/app/(staff)/push-toggle.tsx", "src/app/(staff)/settings/display-settings.tsx"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /register\("\/sw\.js"/, f);
  }
});

test("app shell: /start และ / เป็นหน้า static ไม่รอ server · เช็ก session ฝั่ง client แล้วไปแชทหรือ login ครั้งเดียว", () => {
  for (const f of ["src/app/start/page.tsx", "src/app/page.tsx"]) {
    const page = readFileSync(f, "utf8");
    assert.match(page, /export const dynamic = "force-static";/, f);
    assert.match(page, /<AppShell \/>/, f);
    assert.doesNotMatch(page, /redirect\(|getStaffContext|supabaseServer/, f);
  }
  const shell = readFileSync("src/app/app-shell.tsx", "utf8");
  assert.match(shell, /auth\.getSession\(\)/);
  assert.match(shell, /signedIn: "\/inbox", signedOut: "\/login"/);
  assert.match(shell, /className="sk-row"/, "โครงรายการแชท");
  const root = readFileSync("src/app/layout.tsx", "utf8");
  assert.doesNotMatch(root, /cookies\(\)|next\/headers/, "root layout ไม่อ่าน cookie ฝั่ง server (หน้า shell จึง static ได้)");
  assert.doesNotMatch(root, /fonts\.googleapis\.com/, "ฟอนต์เก็บในเว็บเราเอง");
  assert.match(root, /next\/font\/google/);
  assert.match(root, /startupImage: IOS_STARTUP_IMAGES/);
  const auth = readFileSync("src/lib/auth.ts", "utf8");
  assert.match(auth, /export const getStaffContext = cache\(/, "layout + หน้า ถาม auth ครั้งเดียวต่อคำขอ");
});

test("splash iPhone: ทุกขนาดจอในรายการมีไฟล์ และ media query ตรงขนาด", async () => {
  const { IOS_STARTUP_IMAGES, IPHONE_SCREENS } = await import("../src/lib/startup-images.ts");
  assert.ok(IPHONE_SCREENS.length >= 10);
  for (const img of IOS_STARTUP_IMAGES) {
    assert.ok(existsSync(`public${img.url}`), img.url);
    assert.match(img.media, /^\(device-width: \d+px\) and \(device-height: \d+px\) and \(-webkit-device-pixel-ratio: [23]\) and \(orientation: portrait\)$/);
  }
  assert.ok(IOS_STARTUP_IMAGES.some((i) => i.url === "/splash/iphone-1179x2556.png"), "iPhone 15/16");
});

test("layout: ลงทะเบียน SW ทุกหน้า · meta iPhone · แถบเมนูล่าง + ปุ่มติดตั้งแอป", () => {
  const root = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(root, /<RegisterSW \/>/);
  assert.match(root, /appleWebApp: \{ capable: true/);
  assert.match(root, /viewportFit: "cover"/);
  const css = readFileSync("src/app/globals.css", "utf8");
  const staff = readFileSync("src/app/(staff)/layout.tsx", "utf8");
  assert.match(staff, /<MobileNav chatStaff=\{chatStaff\} calls=\{calls\} labUnmatched=\{labUnmatched\} \/>/);
  assert.doesNotMatch(staff, /<\/div>\s*(\{\/\*[^}]*\*\/\}\s*)?<InstallApp \/>\s*<NavToggle \/>/, "ไม่มีปุ่มติดตั้งถาวรในเมนูซ้าย (ใช้แบนเนอร์ด้านบน)");
  assert.match(staff, /<div className="mnav-only"><InstallApp \/><\/div>/, "ติดตั้ง DocDesk ในหน้าเมนูมือถือ");
  assert.match(css, /\.nav \.mnav-only \{ display: none; \}/, "จอใหญ่ไม่แสดง");
  assert.match(css, /html\[data-mnav-open\] \.nav \.mnav-only \{ display: block; \}/, "แสดงในหน้าเมนูมือถือ");
  const inst = readFileSync("src/app/(staff)/install-app.tsx", "utf8");
  assert.match(inst, /if \(!pwa\.ready \|\| pwa\.isInstalled\) return null;/, "แสดงเฉพาะตอนยังไม่ได้ติดตั้ง");
  const disp = readFileSync("src/app/(staff)/settings/display-settings.tsx", "utf8");
  assert.match(disp, /\{showInstall && \(/, "หน้าตั้งค่า: แถวติดตั้งเฉพาะยังไม่ได้ติดตั้ง");
  assert.match(disp, /<InstallApp variant="settings" \/>/);
  assert.match(css, /\.staff-root:has\(\.inbox\.has-chat\) \.mobile-tabbar \{ display: none; \}/, "ในห้องแชทซ่อนแถบล่าง");
  assert.match(css, /\.mobile-tabbar \{ display: grid;[^}]*height: calc\(68px/, "แถบล่างติดขอบ สูง 68px ตามแบบ");
  const nav = readFileSync("src/app/(staff)/mobile-nav.tsx", "utf8");
  assert.match(nav, /href="\/menu"/, "ปุ่มเมนูไปหน้าเมนู");
  const menu = readFileSync("src/app/(staff)/menu/page.tsx", "utf8");
  assert.doesNotMatch(menu, /WaitingAlert/, "หน้าเมนูไม่มีตัวเล่นเสียงซ้ำกับเมนูซ้าย");
  const badge = readFileSync("src/app/(staff)/mobile-nav.tsx", "utf8");
  assert.match(badge, /channel="appointment-badge-mobile"/, "badge มือถือใช้ realtime channel แยก ไม่ชนกับเมนูซ้าย");
});

// ---------- ปุ่ม/แบนเนอร์ "ติดตั้ง DocDesk" ----------
const pwa = await import("../src/lib/pwa-install.ts");
const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  ipadOS: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  iphoneLine: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.19.0",
  iphoneFb: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 [FBAN/FBIOS;FBAV/490.0.0.39.107;FBBV/1]",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  androidLine: "Mozilla/5.0 (Linux; Android 14; SM-A546E; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 Line/14.19.1/IAB",
  androidFb: "Mozilla/5.0 (Linux; Android 14; SM-A546E Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/490.0.0.40.109;]",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  winEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
};

test("ติดตั้งแอป: แยก iPhone/iPad(รายงานเป็น Mac+touch)/Safari จริง/แอป LINE Facebook/Android", () => {
  const d = pwa.detectInstallPlatform;
  assert.deepEqual(d(UA.iphoneSafari, "iPhone", 5), { isIOS: true, isIPad: false, isAndroid: false, isIOSSafari: true, inApp: null });
  assert.deepEqual(d(UA.ipadOS, "MacIntel", 5), { isIOS: true, isIPad: true, isAndroid: false, isIOSSafari: true, inApp: null });
  assert.equal(d(UA.macSafari, "MacIntel", 0).isIOS, false, "Mac จริงไม่มีจอสัมผัส");
  assert.equal(d(UA.iphoneChrome, "iPhone", 5).inApp, "other");
  assert.equal(d(UA.iphoneLine, "iPhone", 5).inApp, "line");
  assert.equal(d(UA.iphoneFb, "iPhone", 5).inApp, "facebook");
  assert.equal(d(UA.iphoneLine, "iPhone", 5).isIOSSafari, false);
  assert.deepEqual(d(UA.androidChrome, "Linux armv8l", 5), { isIOS: false, isIPad: false, isAndroid: true, isIOSSafari: false, inApp: null });
  assert.equal(d(UA.androidLine, "Linux", 5).inApp, "line");
  assert.equal(d(UA.androidFb, "Linux", 5).inApp, "facebook");
  assert.equal(d(UA.winEdge, "Win32", 0).inApp, null);
});

test("ติดตั้งแอป: กดปุ่มแล้วทำอะไร · แบนเนอร์ขึ้นเมื่อไร · ไว้ทีหลัง 7 วัน", () => {
  const p = (ua, plat = "", t = 5) => pwa.detectInstallPlatform(ua, plat, t);
  const a = (platform, canPrompt = false, isInstalled = false) => pwa.installAction({ platform, canPrompt, isInstalled });
  assert.equal(a(p(UA.androidChrome), true), "prompt");
  assert.equal(a(p(UA.winEdge, "Win32", 0), true), "prompt");
  assert.equal(a(p(UA.winEdge, "Win32", 0), false), "manual");
  assert.equal(a(p(UA.iphoneSafari)), "ios-steps");
  assert.equal(a(p(UA.iphoneLine)), "open-external");
  assert.equal(a(p(UA.androidLine)), "open-external");
  assert.equal(a(p(UA.iphoneSafari), false, true), "installed");

  const b = (platform, canPrompt, snoozed = false, isInstalled = false) => pwa.showInstallBanner({ platform, canPrompt, snoozed, isInstalled });
  assert.equal(b(p(UA.winEdge, "Win32", 0), false), false, "เบราว์เซอร์ยังไม่พร้อมติดตั้ง ไม่ขึ้นแบนเนอร์");
  assert.equal(b(p(UA.winEdge, "Win32", 0), true), true);
  assert.equal(b(p(UA.iphoneSafari), false), true);
  assert.equal(b(p(UA.androidFb), false), true);
  assert.equal(b(p(UA.iphoneSafari), false, true), false, "ไว้ทีหลัง");
  assert.equal(b(p(UA.androidChrome), true, false, true), false, "ติดตั้งแล้ว");

  const now = Date.UTC(2026, 10, 23);
  const until = pwa.snoozeUntil(now);
  assert.equal(Number(until) - now, 7 * 24 * 3600 * 1000);
  assert.equal(pwa.isSnoozed(until, now + 6 * 24 * 3600 * 1000), true);
  assert.equal(pwa.isSnoozed(until, now + 7 * 24 * 3600 * 1000 + 1), false);
  assert.equal(pwa.isSnoozed(null, now), false);
  assert.equal(pwa.isSnoozed("abc", now), false);
});

test("ติดตั้งแอป: ลิงก์เปิดนอกแอป LINE (openExternalBrowser) · Android → Chrome intent", () => {
  const href = "https://docdesk-tau.vercel.app/inbox";
  const line = pwa.detectInstallPlatform(UA.iphoneLine, "iPhone", 5);
  assert.equal(pwa.externalOpenUrl(href, line), "https://docdesk-tau.vercel.app/inbox?openExternalBrowser=1");
  const fbAndroid = pwa.detectInstallPlatform(UA.androidFb, "Linux", 5);
  assert.equal(pwa.externalOpenUrl(href, fbAndroid), "intent://docdesk-tau.vercel.app/inbox#Intent;scheme=https;package=com.android.chrome;end");
  assert.equal(pwa.externalOpenUrl(href, pwa.detectInstallPlatform(UA.iphoneFb, "iPhone", 5)), null, "iOS Facebook: คัดลอกลิงก์");
});

test("ติดตั้งแอป: hook ดัก beforeinstallprompt ระดับ module · รายการติดตั้งแสดงเฉพาะยังไม่ได้ติดตั้ง · localStorage ครอบ try/catch", () => {
  const hook = readFileSync("src/hooks/use-pwa-install.ts", "utf8");
  assert.match(hook, /addEventListener\("beforeinstallprompt", \(e\) => \{\s*e\.preventDefault\(\);/);
  assert.match(hook, /addEventListener\("appinstalled"/);
  assert.match(hook, /\(display-mode: standalone\)/);
  assert.match(hook, /\.standalone === true/);
  const ui = readFileSync("src/app/(staff)/install-app.tsx", "utf8");
  // เจ้าของเปลี่ยนกฎ 23 พ.ย. 2026: ไม่มีปุ่มถาวรในเมนูซ้าย · รายการในเมนูมือถือ/ตั้งค่าแสดงเฉพาะยังไม่ได้ติดตั้ง
  assert.match(ui, /if \(!pwa\.ready \|\| pwa\.isInstalled\) return null;/);
  assert.match(ui, /ติดตั้ง DocDesk/);
  assert.match(ui, /try \{ localStorage\.setItem\(INSTALL_SNOOZE_KEY/);
  assert.match(ui, /กรุณาเปิดใน \{browser\}/);
  assert.match(ui, /เพิ่มไปยังหน้าจอโฮม/);
  const staff = readFileSync("src/app/(staff)/layout.tsx", "utf8");
  assert.match(staff, /<StaffBanners \/>/, "แบนเนอร์ติดตั้ง/แจ้งเตือน");
});
