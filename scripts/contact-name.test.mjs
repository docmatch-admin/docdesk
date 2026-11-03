// ทดสอบการแก้ชื่อลูกค้าและล็อกชื่อ: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { storeIncoming } = await import("../src/lib/pipeline.ts");
const route = await import("../src/app/api/conversations/[id]/contact/route.ts");

const ADMIN = { id: "admin", email: "a@test" };
const AGENT = { id: "agent", email: "b@test" };

beforeEach(() => {
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [
      { id: "fb", type: "facebook", name: "Facebook คลินิก", ai_mode: null, enabled: true, created_at: nextTime() },
      { id: "ln", type: "line", name: "LINE @clinic", ai_mode: null, enabled: true, created_at: nextTime() },
    ],
    contacts: [
      { id: "c-fb", channel_id: "fb", external_id: "PSID1", display_name: "ลูกค้า Facebook", language: "th" },
      { id: "c-ln", channel_id: "ln", external_id: "U1", display_name: "ชื่อไลน์เดิม", language: "th" },
      { id: "c-s", channel_id: "fb", external_id: "PSID2", display_name: "ลูกค้า Facebook", language: "th" },
    ],
    conversations: [
      { id: "cv-fb", contact_id: "c-fb", channel_id: "fb", status: "open", tags: [] },
      { id: "cv-ln", contact_id: "c-ln", channel_id: "ln", status: "open", tags: [] },
      { id: "cv-s", contact_id: "c-s", channel_id: "fb", status: "open", tags: [], sensitive: true },
    ],
    staff: [
      { id: "admin", role: "admin", active: true, display_name: "A" },
      { id: "agent", role: "agent", active: true, display_name: "B", can_view_sensitive: false },
    ],
    tags: [], tag_rules: [], tag_events: [], reply_examples: [],
  });
  state.currentUser = ADMIN;
});

const patch = (id, body) => route.PATCH(
  new Request("https://a.test/x", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);
const contact = (id) => state.tables.contacts.find((c) => c.id === id);

test("แก้ชื่อ: ตัดช่องว่างเกิน บันทึก และล็อกชื่อ", async () => {
  const res = await patch("cv-fb", { displayName: "  คุณ   มิ้นท์  " });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { displayName: "คุณ มิ้นท์" });
  assert.equal(contact("c-fb").display_name, "คุณ มิ้นท์");
  assert.equal(contact("c-fb").name_locked, true);
});

test("ชื่อว่างหรือยาวเกิน 80 ตัวอักษร: 400 และไม่แก้", async () => {
  assert.equal((await patch("cv-fb", { displayName: "   " })).status, 400);
  assert.equal((await patch("cv-fb", { displayName: "ก".repeat(81) })).status, 400);
  assert.equal((await patch("cv-fb", {})).status, 400);
  assert.equal(contact("c-fb").display_name, "ลูกค้า Facebook");
  assert.equal((await patch("cv-fb", { displayName: "ก".repeat(80) })).status, 200);
});

test("แชทลับ: คนไม่มีสิทธิ์แก้ไม่ได้ / ไม่พบแชท: 404 / ไม่ได้ล็อกอิน: 401", async () => {
  state.currentUser = AGENT;
  assert.equal((await patch("cv-s", { displayName: "ชื่อใหม่" })).status, 403);
  assert.equal(contact("c-s").display_name, "ลูกค้า Facebook");
  state.currentUser = ADMIN;
  assert.equal((await patch("missing", { displayName: "ชื่อใหม่" })).status, 404);
  state.currentUser = null;
  assert.equal((await patch("cv-fb", { displayName: "ชื่อใหม่" })).status, 401);
});

test("ชื่อจากแพลตฟอร์มอัปเดตได้ตามปกติเมื่อยังไม่ล็อก", async () => {
  await storeIncoming({ channelType: "line", externalId: "U1", text: "สวัสดีค่ะ", displayName: "ชื่อไลน์ใหม่" });
  assert.equal(contact("c-ln").display_name, "ชื่อไลน์ใหม่");
});

test("ล็อกแล้ว: ข้อความใหม่จาก LINE/Facebook ไม่เขียนชื่อทับ แต่รูปโปรไฟล์ยังอัปเดต", async () => {
  await patch("cv-ln", { displayName: "คุณนก (คนไข้ประจำ)" });
  await storeIncoming({ channelType: "line", externalId: "U1", text: "ทักอีกรอบ", displayName: "ชื่อไลน์ใหม่", avatarUrl: "https://x.test/a.jpg" });
  assert.equal(contact("c-ln").display_name, "คุณนก (คนไข้ประจำ)");
  assert.equal(contact("c-ln").avatar_url, "https://x.test/a.jpg");
  await patch("cv-fb", { displayName: "คุณมิ้นท์" });
  await storeIncoming({ channelType: "facebook", externalId: "PSID1", text: "ทักอีกรอบ", displayName: "Mint S." });
  assert.equal(contact("c-fb").display_name, "คุณมิ้นท์");
});
