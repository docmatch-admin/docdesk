// HR เชื่อมพนักงานกับบัญชี DocDesk (GET /api/hr/staff, POST /api/hr/staff/link): npm test
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const list = await import("../src/app/api/hr/staff/route.ts");
const link = await import("../src/app/api/hr/staff/link/route.ts");

const SECRET = "s".repeat(32);
const AUTH = { authorization: `Bearer ${SECRET}` };
const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  process.env.HR_CREDENTIAL_SECRET = SECRET;
  resetDb({
    staff: [
      { id: S1, username: "emp003", display_name: "เสาวลักษณ์", role: "admin", active: true, hr_employee_id: null, must_change_password: true },
      { id: S2, username: "emp002", display_name: "นงศ์รักษ์", role: "agent", active: true, hr_employee_id: E2, must_change_password: false },
    ],
    system_errors: [],
  });
});

const post = (body, headers = AUTH) => link.POST(new Request("https://app.test/api/hr/staff/link", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }));

test("GET /api/hr/staff: ต้องมี secret · คืนบัญชีพร้อม hr_employee_id ไม่มีอีเมล/รหัส", async () => {
  assert.equal((await list.GET(new Request("https://app.test/api/hr/staff"))).status, 401);
  const res = await list.GET(new Request("https://app.test/api/hr/staff", { headers: AUTH }));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.staff.length, 2);
  assert.deepEqual(Object.keys(j.staff[0]).sort(), ["active", "display_name", "hr_employee_id", "id", "role", "username"]);
});

test("POST link: เชื่อม → ตั้ง hr_employee_id และไม่ต้องเปลี่ยนรหัส · ผูกบัญชีใหม่แทนบัญชีเดิมของพนักงานคนเดียวกัน", async () => {
  assert.equal((await post({ hr_employee_id: E1, staff_id: S1 }, {})).status, 401);
  let res = await post({ hr_employee_id: E1, staff_id: S1 });
  assert.equal(res.status, 200);
  const s1 = state.tables.staff.find((s) => s.id === S1);
  assert.equal(s1.hr_employee_id, E1);
  assert.equal(s1.must_change_password, false);
  // E2 ย้ายจาก S2 ไป S1 ไม่ได้ เพราะ S1 ผูกกับ E1 อยู่
  res = await post({ hr_employee_id: E2, staff_id: S1 });
  assert.equal(res.status, 409);
  // เลิกเชื่อม
  res = await post({ hr_employee_id: E2, staff_id: null });
  assert.equal(res.status, 200);
  assert.equal(state.tables.staff.find((s) => s.id === S2).hr_employee_id, null);
});

test("POST link: ข้อมูลผิดรูปแบบ = 400 · ไม่พบบัญชี = 404", async () => {
  assert.equal((await post({ hr_employee_id: "x", staff_id: S1 })).status, 400);
  assert.equal((await post({ hr_employee_id: E1 })).status, 400);
  assert.equal((await post({ hr_employee_id: E1, staff_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })).status, 404);
});
