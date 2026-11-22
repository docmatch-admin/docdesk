/// <reference lib="webworker" />
// DocDesk service worker (Serwist) — build เป็น /serwist/sw.js โดย src/app/serwist/[path]/route.ts
// - precache: หน้า app shell (/start และ /) + _next/static + ฟอนต์ + ไอคอน + หน้าออฟไลน์ → เปิดแอปครั้งถัดไปขึ้นทันทีแม้เน็ตช้า
// - ห้าม cache ข้อมูลคนไข้ (PDPA): /api/*, Supabase และหน้าเจ้าหน้าที่อื่นทุกหน้าวิ่งไป server เสมอ ไม่เก็บลง cache
//   (app shell ไม่มีข้อมูลคนไข้หรือชื่อเจ้าหน้าที่ — ดึงทุกอย่างหลังเช็ก session ฝั่ง client)
// - แจ้งเตือน push (นัดรอลงระบบ ฯลฯ)
import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist, type PrecacheEntry, type SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const sameOrigin = (url: URL) => url.origin === self.location.origin;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // start_url = /start?source=pwa → ใช้หน้า shell ตัวเดียวกับ /start
  precacheOptions: { cleanupOutdatedCaches: true, ignoreURLParametersMatching: [/^utm_/, /^fbclid$/, /^source$/] },
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  disableDevLogs: true,
  runtimeCaching: [
    // ห้าม cache: API ของเรา และทุกอย่างที่ไป Supabase (ข้อมูลคนไข้/แชท)
    { matcher: ({ url }) => sameOrigin(url) && url.pathname.startsWith("/api/"), handler: new NetworkOnly() },
    { matcher: ({ url }) => url.hostname.endsWith(".supabase.co"), handler: new NetworkOnly() },
    // หน้าเว็บอื่น (ที่ไม่ใช่ shell ซึ่งถูก precache แล้ว): ไป server เสมอ ไม่เก็บ · ออฟไลน์ขึ้นหน้าออฟไลน์
    { matcher: ({ request }) => request.mode === "navigate", handler: new NetworkOnly() },
    // RSC payload ของหน้าเจ้าหน้าที่มีข้อมูลจริง → ไม่เก็บ
    { matcher: ({ request }) => request.headers.get("RSC") === "1", handler: new NetworkOnly() },
    // ไฟล์ build (ชื่อมี hash ไม่เปลี่ยน) ที่ยังไม่อยู่ใน precache เช่น chunk ที่เพิ่งโหลด: cache-first
    {
      matcher: ({ url }) => sameOrigin(url) && url.pathname.startsWith("/_next/static/"),
      handler: new CacheFirst({ cacheName: "next-static", plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 60 })] }),
    },
    {
      matcher: ({ url }) => sameOrigin(url) && url.pathname.startsWith("/icons/"),
      handler: new CacheFirst({ cacheName: "icons", plugins: [new ExpirationPlugin({ maxEntries: 40 })] }),
    },
  ],
  fallbacks: {
    entries: [{ url: "/offline.html", matcher: ({ request }) => request.destination === "document" }],
  },
});

serwist.addEventListeners();

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || "DocDesk", {
    body: data.body || "",
    tag: data.tag || "docdesk-booking",
    // @ts-expect-error renotify ยังไม่อยู่ใน lib ของ TypeScript แต่ Chrome/Android รองรับ
    renotify: true,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { url: data.url || "/inbox" },
  }));
});

// กดแจ้งเตือน: ใช้หน้าต่าง DocDesk ที่เปิดอยู่แล้ว (แอปที่ติดตั้ง) ถ้ามี ไม่เปิดหน้าต่างซ้อน
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/inbox", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.location.origin));
    if (win) {
      await win.focus();
      if ("navigate" in win) { await win.navigate(url); }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
