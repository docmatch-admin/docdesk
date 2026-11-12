// ทดสอบล็อกอินพนักงานและการเตรียมเชื่อม HR: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const { getStaffContext, requireStaff } = await import("../src/lib/auth.ts");
const { isValidUsername, toLoginEmail } = await import("../src/lib/staff-login.ts");
const { generateTempPassword } = await import("../src/lib/staff-admin.ts");
const { staffChangeError } = await import("../src/lib/staff-rules.ts");
const { applyHrSync, fetchHrEmployees, hrDisplayName, hrFullName } = await import("../src/lib/hr-sync.ts");
const staffApi = await import("../src/app/api/staff/route.ts");
const hrApi = await import("../src/app/api/staff/hr/route.ts");
const passwordApi = await import("../src/app/api/account/password/route.ts");

const ADMIN = { id: "admin-1", email: "a@test" };
const AGENT = { id: "agent-1", email: "b@test" };
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetDb({
    staff: [
      { id: ADMIN.id, role: "admin", active: true, display_name: "A", must_change_password: false },
      { id: AGENT.id, role: "agent", active: true, display_name: "B", must_change_password: false, hr_employee_id: "hr-1" },
    ],
    conversations: [
      { id: "open-1", status: "open", assigned_to: AGENT.id, tags: [] },
      { id: "closed-1", status: "closed", assigned_to: AGENT.id, tags: [] },
      { id: "other-1", status: "open", assigned_to: ADMIN.id, tags: [] },
    ],
  });
  state.currentUser = ADMIN;
  delete process.env.HR_SYNC_URL;
  delete process.env.HR_SYNC_SECRET;
  delete process.env.HR_KPI_URL;
  delete process.env.HR_KPI_KEY;
});
afterEach(() => { globalThis.fetch = realFetch; });

const json = (method, body) => new Request("https://app.test/x", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const row = (id) => state.tables.staff.find((s) => s.id === id);
const addStaff = (body) => staffApi.POST(json("POST", body));
const patch = (body) => staffApi.PATCH(json("PATCH", body));

// ---- ชื่อผู้ใช้ ----
test("แปลงชื่อผู้ใช้เป็นอีเมลภายใน", () => {
  assert.equal(toLoginEmail("nurse.a"), "nurse.a@staff.docdesk.local");
  assert.equal(toLoginEmail("  Nurse_A "), "nurse_a@staff.docdesk.local");
});
test("อีเมลของแอดมินเดิมใช้ได้ตามเดิม", () => {
  assert.equal(toLoginEmail("Admin@Example.com"), "admin@example.com");
});
for (const ok of ["abc", "a.b_c9", "a2345678901234567890"]) test(`ชื่อผู้ใช้ใช้ได้: ${ok}`, () => assert.equal(isValidUsername(ok), true));
for (const bad of ["ab", "a23456789012345678901", "ABC", "มานี", "a b", "a@b", ".abc", "abc.", "a..b", ""]) {
  test(`ชื่อผู้ใช้ใช้ไม่ได้: "${bad}"`, () => assert.equal(isValidUsername(bad), false));
}

test("รหัสชั่วคราวยาว 10 ตัว ไม่มีตัวสับสน และไม่ซ้ำกัน", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = generateTempPassword();
    assert.equal(p.length, 10);
    assert.doesNotMatch(p, /[0Oo1lIi]/);
    assert.match(p, /^[A-Za-z0-9]+$/);
    seen.add(p);
  }
  assert.equal(seen.size, 500);
});

// ---- เพิ่มพนักงาน ----
test("เพิ่มพนักงาน: ค่าเริ่มต้นเป็น agent ต้องเปลี่ยนรหัส และคืนรหัสครั้งเดียว", async () => {
  const res = await addStaff({ display_name: "มานี", username: "Manee" });
  const j = await res.json();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(j.password.length, 10);
  const created = row(j.id);
  assert.deepEqual([created.role, created.username, created.must_change_password], ["agent", "manee", true]);
  assert.equal(state.authUsers.at(-1).email, "manee@staff.docdesk.local");
});

test("รหัสไม่ถูกเก็บในตาราง และไม่ถูก log แม้สร้างไม่สำเร็จ", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (...a) => logged.push(a));
  t.mock.method(console, "log", (...a) => logged.push(a));
  const { password } = await (await addStaff({ display_name: "x", username: "user_x" })).json();
  await addStaff({ display_name: "x", username: "user_x" });
  assert.ok(!JSON.stringify(state.tables).includes(password));
  assert.ok(!JSON.stringify(logged).includes(password));
});

test("ชื่อผู้ใช้ซ้ำ: ไม่สร้างแถวเพิ่ม", async () => {
  await addStaff({ display_name: "x", username: "dup" });
  const before = state.tables.staff.length;
  assert.equal((await addStaff({ display_name: "y", username: "dup" })).status, 400);
  assert.equal(state.tables.staff.length, before);
});

test("ชื่อผู้ใช้หรือชื่อไม่ถูกต้อง: 400", async () => {
  assert.equal((await addStaff({ display_name: "x", username: "a" })).status, 400);
  assert.equal((await addStaff({ display_name: " ", username: "abc" })).status, 400);
});

// ---- รีเซ็ตและปิดบัญชี ----
test("รีเซ็ตรหัส: ได้รหัสใหม่ ต้องเปลี่ยนรหัส และตัด session เดิม", async () => {
  const j = await (await patch({ id: AGENT.id, reset_password: true })).json();
  assert.equal(j.password.length, 10);
  assert.equal(row(AGENT.id).must_change_password, true);
  assert.deepEqual(state.revoked, [AGENT.id]);
  assert.equal(state.authUsers.find((u) => u.id === AGENT.id).password, j.password);
});

test("รีเซ็ตรหัสตัวเองไม่ได้", async () => {
  assert.equal((await patch({ id: ADMIN.id, reset_password: true })).status, 400);
  assert.equal(row(ADMIN.id).must_change_password, false);
});

test("ปิดบัญชี: แบน, active false, ตัด session, เอาออกเฉพาะแชทเปิดของคนนั้น พร้อมประวัติ", async () => {
  assert.equal((await patch({ id: AGENT.id, active: false })).status, 200);
  assert.equal(row(AGENT.id).active, false);
  assert.equal(state.authUsers.find((u) => u.id === AGENT.id).ban_duration, "876000h");
  assert.deepEqual(state.revoked, [AGENT.id]);
  const chat = (id) => state.tables.conversations.find((c) => c.id === id);
  assert.equal(chat("open-1").assigned_to, null);
  assert.equal(chat("closed-1").assigned_to, AGENT.id);
  assert.equal(chat("other-1").assigned_to, ADMIN.id);
  assert.deepEqual(state.tables.assignment_log.map((l) => [l.conversation_id, l.by_staff]), [["open-1", ADMIN.id]]);
});

test("เปิดบัญชี: ยกเลิกแบน", async () => {
  await patch({ id: AGENT.id, active: false });
  assert.equal((await patch({ id: AGENT.id, active: true })).status, 200);
  assert.equal(row(AGENT.id).active, true);
  assert.equal(state.authUsers.find((u) => u.id === AGENT.id).ban_duration, "none");
});

test("admin ปิดบัญชีตัวเองหรือลดสิทธิ์ตัวเองไม่ได้", async () => {
  assert.equal((await patch({ id: ADMIN.id, active: false })).status, 400);
  assert.equal((await patch({ id: ADMIN.id, role: "agent" })).status, 400);
  assert.equal(row(ADMIN.id).active, true);
  assert.equal(row(ADMIN.id).role, "admin");
  assert.equal(state.authUsers.length, 0, "ต้องไม่แบน");
});

test("admin คนสุดท้ายถูกปิดไม่ได้", () => {
  const list = [{ id: "a", role: "admin", active: true }, { id: "b", role: "agent", active: true }];
  assert.match(staffChangeError("z", list[0], { active: false }, list), /อย่างน้อย 1/);
});

test("agent จัดการบัญชีไม่ได้", async () => {
  state.currentUser = AGENT;
  assert.equal((await addStaff({ display_name: "x", username: "abc" })).status, 403);
  assert.equal((await patch({ id: ADMIN.id, reset_password: true })).status, 403);
});

// ---- บังคับเปลี่ยนรหัส ----
test("ยังไม่เปลี่ยนรหัส: API อื่นถูกปฏิเสธ แต่รู้สถานะของตัวเอง", async () => {
  row(AGENT.id).must_change_password = true;
  state.currentUser = AGENT;
  const r = await requireStaff();
  assert.equal(r.error.status, 403);
  assert.equal((await r.error.json()).error, "must_change_password");
  assert.equal((await getStaffContext()).mustChangePassword, true);
});

test("เปลี่ยนรหัสสำเร็จ: ปลดล็อกและใช้ API ได้", async () => {
  row(AGENT.id).must_change_password = true;
  state.currentUser = AGENT;
  assert.equal((await passwordApi.POST(json("POST", { password: "newpass12" }))).status, 200);
  assert.equal(row(AGENT.id).must_change_password, false);
  assert.deepEqual(state.passwordChanges, [{ id: AGENT.id, password: "newpass12" }]);
  assert.equal((await requireStaff()).error, null);
});

for (const [name, password] of [["7 ตัว", "1234567"], ["ยาวเกิน", "x".repeat(73)], ["ไม่ใช่ข้อความ", 12345678]]) {
  test(`รหัสใหม่ไม่ผ่าน: ${name}`, async () => {
    row(AGENT.id).must_change_password = true;
    state.currentUser = AGENT;
    assert.equal((await passwordApi.POST(json("POST", { password }))).status, 400);
    assert.equal(row(AGENT.id).must_change_password, true);
    assert.equal(state.passwordChanges.length, 0);
  });
}

test("รหัสใหม่ซ้ำรหัสเดิม: ยังต้องเปลี่ยนรหัส", async () => {
  row(AGENT.id).must_change_password = true;
  state.currentUser = AGENT;
  state.updateUserError = { code: "same_password" };
  const res = await passwordApi.POST(json("POST", { password: "samepass1" }));
  assert.equal(res.status, 400);
  assert.equal(row(AGENT.id).must_change_password, true);
});

test("เปลี่ยนรหัส: ไม่ล็อกอิน 401, บัญชีปิด 403", async () => {
  state.currentUser = null;
  assert.equal((await passwordApi.POST(json("POST", { password: "newpass12" }))).status, 401);
  row(AGENT.id).active = false;
  state.currentUser = AGENT;
  assert.equal((await passwordApi.POST(json("POST", { password: "newpass12" }))).status, 403);
});

test("migration กันที่ฐานข้อมูลด้วย และอ่านแถวตัวเองได้", () => {
  const sql = readFileSync("supabase/migrations/022_staff_login.sql", "utf8");
  assert.equal(sql.match(/and not must_change_password/g).length, 2);
  assert.match(sql, /create policy own_read on staff/);
  assert.match(sql, /revoke all on function revoke_staff_sessions\(uuid\) from public, anon, authenticated/);
  assert.doesNotMatch(sql, /password text/);
});

// ---- HR ----
const emp = (over = {}) => ({
  id: "hr-1", employee_code: "E001", title: "นางสาว", first_name: "สมใจ", last_name: "ใจดี", nickname: "ใจ",
  position: "พยาบาล", employment_status: "active", ...over,
});

test("HR: ใช้ชื่อเล่นเป็นชื่อที่แสดง พร้อมชื่อเต็มและตำแหน่ง", async () => {
  const r = await applyHrSync([emp()], ADMIN.id);
  assert.deepEqual([r.updated, r.deactivated, r.unmatched], [1, 0, 0]);
  const s = row(AGENT.id);
  assert.deepEqual([s.display_name, s.full_name, s.position, s.active], ["ใจ", "นางสาว สมใจ ใจดี", "พยาบาล", true]);
});

for (const nickname of [null, "", "   "]) {
  test(`HR: ไม่มีชื่อเล่น (${JSON.stringify(nickname)}) ใช้ชื่อจริง`, async () => {
    await applyHrSync([emp({ nickname })], ADMIN.id);
    assert.equal(row(AGENT.id).display_name, "สมใจ");
  });
}

test("HR: ไม่มีทั้งชื่อเล่นและชื่อจริง คงชื่อเดิม", async () => {
  await applyHrSync([emp({ nickname: null, first_name: null, title: null, last_name: null })], ADMIN.id);
  assert.equal(row(AGENT.id).display_name, "B");
  assert.equal(hrFullName(emp({ title: null, first_name: null, last_name: null })), null);
  assert.equal(hrDisplayName(emp({ nickname: null, first_name: null })), null);
});

for (const status of ["resigned", "terminated", "RESIGNED", " terminated "]) {
  test(`HR: สถานะ "${status}" ต้องถูกปิดบัญชี และเอาออกจากแชทเปิด`, async () => {
    const r = await applyHrSync([emp({ employment_status: status })], ADMIN.id);
    assert.equal(r.deactivated, 1);
    assert.equal(row(AGENT.id).active, false);
    assert.equal(state.authUsers.find((u) => u.id === AGENT.id).ban_duration, "876000h");
    assert.equal(state.tables.conversations.find((c) => c.id === "open-1").assigned_to, null);
  });
}

for (const status of ["active", "probation", "on_leave", null]) {
  test(`HR: สถานะ ${status} ไม่ปิดบัญชี`, async () => {
    assert.equal((await applyHrSync([emp({ employment_status: status })], ADMIN.id)).deactivated, 0);
    assert.equal(row(AGENT.id).active, true);
  });
}

test("HR: ไม่เปิดบัญชีคืนอัตโนมัติ และไม่นับปิดซ้ำ", async () => {
  row(AGENT.id).active = false;
  assert.equal((await applyHrSync([emp({ employment_status: "resigned" })], ADMIN.id)).deactivated, 0);
  await applyHrSync([emp()], ADMIN.id);
  assert.equal(row(AGENT.id).active, false);
});

test("HR: พนักงานที่ไม่ได้จับคู่ไม่สร้างบัญชี", async () => {
  const before = state.tables.staff.length;
  const r = await applyHrSync([emp({ id: "hr-unknown", employment_status: "resigned" })], ADMIN.id);
  assert.equal(r.unmatched, 1);
  assert.equal(state.tables.staff.length, before);
  assert.equal(row(AGENT.id).active, true);
});

test("HR: ไม่ปิดบัญชีคนที่กดซิงก์หรือ admin คนสุดท้าย และรายงานว่าข้าม", async () => {
  row(ADMIN.id).hr_employee_id = "hr-admin";
  const self = await applyHrSync([emp({ id: "hr-admin", employment_status: "resigned" })], ADMIN.id);
  assert.equal(row(ADMIN.id).active, true);
  assert.match(self.skipped[0], /ตัวเอง/);
  const last = await applyHrSync([emp({ id: "hr-admin", employment_status: "resigned" })], "system");
  assert.equal(row(ADMIN.id).active, true);
  assert.match(last.skipped[0], /อย่างน้อย 1/);
});

test("HR: admin สองคนลาออกพร้อมกัน เหลืออย่างน้อย 1 คน", async () => {
  row(ADMIN.id).hr_employee_id = "hr-a";
  row(AGENT.id).role = "admin";
  await applyHrSync([emp({ id: "hr-a", employment_status: "resigned" }), emp({ id: "hr-1", employment_status: "resigned" })], "system");
  assert.equal(state.tables.staff.filter((s) => s.role === "admin" && s.active).length, 1);
});

test("HR: ไม่ได้ตั้ง env ซ่อนปุ่มและ API ใช้ไม่ได้", async () => {
  assert.equal((await (await staffApi.GET()).json()).hrEnabled, false);
  process.env.HR_SYNC_URL = "https://hr.test/x";
  assert.equal((await (await staffApi.GET()).json()).hrEnabled, false, "ต้องตั้งครบทั้งสองค่า");
  assert.equal((await hrApi.GET()).status, 404);
  assert.equal((await hrApi.POST()).status, 404);
});

const withHr = (body, status = 200) => {
  process.env.HR_SYNC_URL = "https://hr.test/x";
  process.env.HR_SYNC_SECRET = "s3cret";
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init.headers.Authorization]); return new Response(JSON.stringify(body), { status }); };
  return calls;
};

test("HR: เรียก URL พร้อม secret รับได้ทั้ง array และ { employees }", async () => {
  const calls = withHr([emp()]);
  assert.equal((await fetchHrEmployees()).length, 1);
  assert.deepEqual(calls[0], ["https://hr.test/x", "Bearer s3cret"]);
  withHr({ employees: [emp()] });
  assert.equal((await fetchHrEmployees()).length, 1);
  assert.equal((await (await staffApi.GET()).json()).hrEnabled, true);
});

test("HR: ข้อมูลผิดรูปแบบหรือ HR ล่ม ไม่ซิงก์ครึ่งเดียว", async (t) => {
  t.mock.method(console, "error", () => {});
  withHr([emp({ employment_status: "resigned" }), { first_name: "ไม่มี id" }]);
  assert.equal((await hrApi.POST()).status, 502);
  assert.equal(row(AGENT.id).active, true);
  withHr({ error: "x" }, 500);
  assert.equal((await hrApi.POST()).status, 502);
});

test("HR: ซิงก์ผ่าน API และ dropdown ไม่ได้ข้อมูลเกินจำเป็น", async () => {
  withHr([emp({ employment_status: "resigned" })]);
  assert.equal((await (await hrApi.POST()).json()).deactivated, 1);
  const { employees } = await (await hrApi.GET()).json();
  assert.deepEqual(Object.keys(employees[0]).sort(), ["employee_code", "employment_status", "id", "name"]);
});

test("HR: agent ใช้ไม่ได้", async () => {
  state.currentUser = AGENT;
  assert.equal((await hrApi.POST()).status, 403);
  assert.equal((await hrApi.GET()).status, 403);
});

test("จับคู่ HR: รับเฉพาะ uuid และยกเลิกได้", async () => {
  assert.equal((await patch({ id: AGENT.id, hr_employee_id: "not-uuid" })).status, 400);
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal((await patch({ id: AGENT.id, hr_employee_id: id })).status, 200);
  assert.equal(row(AGENT.id).hr_employee_id, id);
  assert.equal((await patch({ id: AGENT.id, hr_employee_id: null })).status, 200);
  assert.equal(row(AGENT.id).hr_employee_id, null);
});
