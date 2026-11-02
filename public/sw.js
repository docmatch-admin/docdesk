// แจ้งเตือนนัดที่ยังไม่ลงระบบ ไม่ cache หน้าเว็บ
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || "DocDesk", {
    body: data.body || "",
    tag: "docdesk-booking",
    renotify: true,
    data: { url: data.url || "/inbox" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(event.notification.data.url));
});
