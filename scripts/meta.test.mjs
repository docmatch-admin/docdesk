// ทดสอบ Facebook Messenger + Instagram: npm test
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { MetaWindowError, metaMessagingType, parseMetaWebhook, splitForMeta, verifyMetaSignature } from "../src/lib/channels/meta.ts";

test("ตรวจลายเซ็น X-Hub-Signature-256", () => {
  process.env.META_APP_SECRET = "s3cret";
  const raw = JSON.stringify({ a: 1 });
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(raw).digest("hex");
  assert.equal(verifyMetaSignature(raw, sig), true);
  assert.equal(verifyMetaSignature(raw + " ", sig), false);
  assert.equal(verifyMetaSignature(raw, null), false);
  assert.equal(verifyMetaSignature(raw, "sha1=abc"), false);
});

test("ไม่มี META_APP_SECRET ต้องไม่ผ่านลายเซ็น", () => {
  const saved = process.env.META_APP_SECRET;
  delete process.env.META_APP_SECRET;
  try {
    const raw = "{}";
    const sig = "sha256=" + crypto.createHmac("sha256", "").update(raw).digest("hex");
    assert.equal(verifyMetaSignature(raw, sig), false);
  } finally {
    if (saved !== undefined) process.env.META_APP_SECRET = saved;
  }
});

test("แปลง webhook ของ Messenger: ข้าม echo และแปลงไฟล์แนบเป็นข้อความแจ้ง", () => {
  const fb = parseMetaWebhook({ object: "page", entry: [{ id: "PAGE", messaging: [
    { sender: { id: "U1" }, recipient: { id: "PAGE" }, message: { mid: "m1", text: "สวัสดี" } },
    { sender: { id: "PAGE" }, recipient: { id: "U1" }, message: { mid: "m2", text: "echo", is_echo: true } },
    { sender: { id: "U2" }, recipient: { id: "PAGE" }, message: { mid: "m3", attachments: [{ type: "image" }] } },
    { sender: { id: "U3" }, recipient: { id: "PAGE" } },
  ] }] });
  assert.equal(fb.length, 2);
  assert.deepEqual(fb[0], { kind: "facebook", senderId: "U1", messageId: "m1", text: "สวัสดี", isText: true });
  assert.equal(fb[1].isText, false);
  assert.match(fb[1].text, /รูปภาพ/);
});

test("แปลง webhook ของ Instagram และไม่รับ object อื่น", () => {
  const ig = parseMetaWebhook({ object: "instagram", entry: [{ id: "IGB", messaging: [
    { sender: { id: "IGSID" }, recipient: { id: "IGB" }, message: { mid: "x", text: "price?" } },
  ] }] });
  assert.equal(ig[0].kind, "instagram");
  assert.equal(parseMetaWebhook({ object: "whatsapp_business_account", entry: [] }).length, 0);
});

test("แบ่งข้อความยาวตามขีดจำกัดของแต่ละช่องทาง", () => {
  const thai = "ก".repeat(900); // 900 ตัวอักษร = 2700 bytes
  const igParts = splitForMeta("instagram", thai);
  assert.ok(igParts.every((p) => Buffer.byteLength(p) <= 1000));
  assert.equal(igParts.join(""), thai);
  assert.equal(splitForMeta("facebook", thai).length, 1);

  const words = Array.from({ length: 400 }, (_, i) => "word" + i).join(" ");
  const wordParts = splitForMeta("instagram", words);
  assert.ok(wordParts.every((p) => Buffer.byteLength(p) <= 1000));
  assert.equal(wordParts.join(" ").replace(/\s+/g, " "), words);
  assert.deepEqual(splitForMeta("facebook", "สั้นๆ"), ["สั้นๆ"]);
});

test("กติกาเวลา 24 ชม. / 7 วัน", () => {
  const H = 3_600_000, now = Date.now();
  assert.deepEqual(metaMessagingType(new Date(now - 2 * H), "ai", now), { messaging_type: "RESPONSE" });
  assert.deepEqual(metaMessagingType(new Date(now - 30 * H), "staff", now), { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  assert.throws(() => metaMessagingType(new Date(now - 30 * H), "ai", now), MetaWindowError);
  assert.throws(() => metaMessagingType(new Date(now - 8 * 24 * H), "staff", now), MetaWindowError);
  assert.throws(() => metaMessagingType(null, "staff", now), MetaWindowError);
});
