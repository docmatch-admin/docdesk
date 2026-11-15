// realtime หลุดแล้วต่อใหม่ + ดึงข้อมูลที่พลาด (ข้อมูลใหม่ไม่ขึ้นจนต้องกด F5): npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = readFileSync("src/lib/use-live-channel.ts", "utf8");

test("hook: ต่อใหม่เมื่อหลุด หน่วงเพิ่มทีละขั้น และ resync หลังต่อกลับ", async () => {
  const { retryDelay } = await import("../src/lib/use-live-channel.ts");
  assert.deepEqual([0, 1, 2, 3, 9].map(retryDelay), [2000, 5000, 15000, 30000, 30000]);
  for (const s of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) assert.match(src, new RegExp(`"${s}"`));
  assert.match(src, /if \(reconnected\) resyncRef\.current\(\)/);
  assert.match(src, /visibilitychange/);
  assert.match(src, /"online"/);
  assert.match(src, /setInterval\(kick, pollMs\)/);
  assert.doesNotMatch(src, /location\.reload/, "ไม่ reload ทั้งหน้า ข้อความที่พิมพ์ค้างไว้ต้องไม่หาย");
});

test("ทุกหน้าที่ใช้ realtime ใช้ hook ที่ซ่อมตัวเองได้ (ยกเว้นที่มี poll สำรองอยู่แล้ว)", () => {
  for (const f of [
    "src/app/(staff)/inbox/inbox-client.tsx",
    "src/app/(staff)/inbox/team-panel.tsx",
    "src/app/(staff)/inbox/appointments-block.tsx",
    "src/app/(staff)/appointments/appointments-client.tsx",
    "src/app/(staff)/appointments/appointments-mobile.tsx",
    "src/app/(staff)/bookings/bookings-client.tsx",
  ]) {
    const s = readFileSync(f, "utf8");
    assert.match(s, /useLiveChannel\(/, f);
    assert.doesNotMatch(s, /\.subscribe\(\)/, `${f} ยังมี channel ที่ไม่ต่อใหม่เอง`);
  }
  const inbox = readFileSync("src/app/(staff)/inbox/inbox-client.tsx", "utf8");
  assert.match(inbox, /\(\) => \{ loadConvs\(\); refreshSelected\(\); \}/, "inbox resync: รายการแชท + ข้อความในแชทที่เปิดอยู่");
  assert.match(inbox, /return same \? prev : rows/, "resync ไม่ล้างหน้าจอถ้าไม่มีอะไรใหม่");
});
