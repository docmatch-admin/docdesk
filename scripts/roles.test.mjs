// ทดสอบการแยกสิทธิ์ admin / agent: npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const { requireAdmin, requireStaff } = await import("../src/lib/auth.ts");
const { staffChangeError } = await import("../src/lib/staff-rules.ts");

const knowledge = await import("../src/app/api/knowledge/route.ts");
const exportExamples = await import("../src/app/api/examples/export/route.ts");
const exportReport = await import("../src/app/api/reports/export/route.ts");
const quickMedia = await import("../src/app/api/quick-media/route.ts");
const staffApi = await import("../src/app/api/staff/route.ts");
const tags = await import("../src/app/api/conversations/[id]/tags/route.ts");

const ADMIN = { id: "admin-1", email: "a@test" };
const AGENT = { id: "agent-1", email: "b@test" };
const OFF = { id: "off-1", email: "c@test" };

beforeEach(() => {
  resetDb({
    staff: [
      { id: ADMIN.id, role: "admin", active: true, display_name: "A" },
      { id: AGENT.id, role: "agent", active: true, display_name: "B" },
      { id: OFF.id, role: "admin", active: false, display_name: "C" },
    ],
    conversations: [{ id: "c1", tags: [] }],
    tags: [{ id: "t", name: "วัคซีน" }],
    tag_events: [],
    tag_rules: [],
  });
  state.currentUser = AGENT;
});

const json = (method, body) => new Request("https://app.test/x?from=2026-11-01&to=2026-11-02&id=q1", {
  method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});
const ADMIN_ROUTES = [
  ["เพิ่มฐานข้อมูลคลินิก", () => knowledge.POST(json("POST", { title: "t", content: "c" }))],
  ["ส่งออกข้อมูลเทรน", () => exportExamples.GET(json("GET"))],
  ["ส่งออกรายงานแท็ก", () => exportReport.GET(json("GET"))],
  ["เพิ่มรูปที่ใช้บ่อย", () => quickMedia.POST(json("POST", { uploadPath: "uploads/staff-1", title: "x" }))],
  ["ลบรูปที่ใช้บ่อย", () => quickMedia.DELETE(json("DELETE"))],
  ["ดูรายชื่อเจ้าหน้าที่", () => staffApi.GET()],
  ["เพิ่มเจ้าหน้าที่", () => staffApi.POST(json("POST", { email: "x@y.z", display_name: "x" }))],
  ["เปลี่ยน role", () => staffApi.PATCH(json("PATCH", { id: AGENT.id, role: "admin" }))],
];

for (const [name, call] of ADMIN_ROUTES) {
  test(`agent เรียก ${name}: 403`, async () => {
    assert.equal((await call()).status, 403);
  });
  test(`บัญชีที่ถูกปิด เรียก ${name}: 403`, async () => {
    state.currentUser = OFF;
    assert.equal((await call()).status, 403);
  });
  test(`ไม่ได้ล็อกอิน เรียก ${name}: 401`, async () => {
    state.currentUser = null;
    assert.equal((await call()).status, 401);
  });
}

test("agent เปลี่ยน role ตัวเองเป็น admin ไม่ได้ และข้อมูลไม่เปลี่ยน", async () => {
  await staffApi.PATCH(json("PATCH", { id: AGENT.id, role: "admin" }));
  assert.equal(state.tables.staff.find((s) => s.id === AGENT.id).role, "agent");
});

test("agent ยังติดแท็กได้", async () => {
  const res = await tags.POST(json("POST", { tag: "วัคซีน", action: "add" }), { params: Promise.resolve({ id: "c1" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(state.tables.conversations[0].tags, ["วัคซีน"]);
});

test("requireStaff และ requireAdmin แยกตาม role", async () => {
  assert.equal((await requireStaff()).role, "agent");
  assert.ok((await requireAdmin()).error);
  state.currentUser = ADMIN;
  const r = await requireAdmin();
  assert.equal(r.error, null);
  assert.equal(r.user.id, ADMIN.id);
});

// ---- กฎการแก้บัญชี ----
const row = (id, role = "agent", active = true) => ({ id, role, active });
const solo = [row("me", "admin"), row("x")];
const two = [row("me", "admin"), row("other", "admin"), row("x")];

test("ปิดบัญชีตัวเองหรือลดสิทธิ์ตัวเองไม่ได้", () => {
  assert.match(staffChangeError("me", two[0], { active: false }, two), /ตัวเอง/);
  assert.match(staffChangeError("me", two[0], { role: "agent" }, two), /ตัวเอง/);
});

test("ต้องเหลือ admin อย่างน้อย 1 คน", () => {
  assert.match(staffChangeError("x", solo[0], { role: "agent" }, solo), /อย่างน้อย 1/);
  assert.match(staffChangeError("x", solo[0], { active: false }, solo), /อย่างน้อย 1/);
  assert.equal(staffChangeError("me", two[1], { role: "agent" }, two), null);
  assert.equal(staffChangeError("me", two[1], { active: false }, two), null);
});

test("admin ที่ถูกปิดไม่นับเป็น admin ที่เหลือ", () => {
  const list = [row("a", "admin"), row("b", "admin", false)];
  assert.match(staffChangeError("z", list[0], { role: "agent" }, list), /อย่างน้อย 1/);
});

test("แก้ agent ทั่วไปได้ และ role แปลกๆ ไม่ได้", () => {
  assert.equal(staffChangeError("me", solo[1], { role: "admin" }, solo), null);
  assert.equal(staffChangeError("me", solo[1], { active: false }, solo), null);
  assert.match(staffChangeError("me", solo[1], { role: "owner" }, solo), /role/);
  assert.match(staffChangeError("me", solo[1], { display_name: " " }, solo), /ชื่อ/);
});
