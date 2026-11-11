// DocDesk service worker
// - ทำให้ติดตั้งเป็นแอปได้ และขึ้นหน้า "ไม่มีอินเทอร์เน็ต" แทนหน้าพังเมื่อออฟไลน์
// - ไม่ cache หน้าเว็บหรือข้อมูลคนไข้ (PDPA): เก็บแค่หน้าออฟไลน์ + ไอคอน · ทุกคำขออื่นวิ่งไปที่ server ตามปกติ
// - แจ้งเตือน push (นัดรอลงระบบ ฯลฯ)
const CACHE = "docdesk-shell-v1";
const SHELL = ["/offline.html", "/icons/icon-192.png", "/icons/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// เฉพาะการเปิดหน้า (navigation): ออนไลน์ใช้ server เสมอ · ออฟไลน์ขึ้นหน้าออฟไลน์
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(fetch(req).catch(() => caches.match("/offline.html")));
});

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || "DocDesk", {
    body: data.body || "",
    tag: data.tag || "docdesk-booking",
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
      if ("navigate" in win) return win.navigate(url);
      return;
    }
    return self.clients.openWindow(url);
  })());
});
