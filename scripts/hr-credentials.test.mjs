// รับ hash รหัสผ่านจาก HR: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

await import(fake("admin"));
const { parseCredentialPush, secretMatches, BCRYPT_HASH } = await import("../src/lib/hr-credentials.ts");
const ID = "123e4567-e89b-12d3-a456-426614174000";
const HASH = "$2a$10$" + "a".repeat(53);

test("รับเฉพาะ bcrypt hash กับรหัสพนักงานแบบ uuid", () => {
  assert.deepEqual(parseCredentialPush({ hr_employee_id: ID, password_hash: HASH }), { hr_employee_id: ID, password_hash: HASH });
  for (const bad of [null, "x", {}, { hr_employee_id: ID, password_hash: "Passw0rd!" }, { hr_employee_id: "EMP001", password_hash: HASH },
    { hr_employee_id: ID, password_hash: "$2a$10$short" }, { hr_employee_id: ID, password_hash: "$1$" + "a".repeat(53) }]) {
    assert.equal(parseCredentialPush(bad), null);
  }
  assert.match(HASH, BCRYPT_HASH);
});

test("secret: ต้องตรงและยาวพอ ไม่ตั้งค่า = ปฏิเสธหมด", () => {
  const s = "s".repeat(32);
  assert.equal(secretMatches(`Bearer ${s}`, s), true);
  assert.equal(secretMatches(`Bearer ${s}x`, s), false);
  assert.equal(secretMatches(s, s), false);
  assert.equal(secretMatches(null, s), false);
  assert.equal(secretMatches("Bearer ", ""), false);
  assert.equal(secretMatches("Bearer short", "short"), false);
  assert.equal(secretMatches("Bearer undefined", undefined), false);
});

test("route ตรวจ secret ก่อนอ่าน body และไม่ log hash", () => {
  const src = readFileSync("src/app/api/hr/credentials/route.ts", "utf8");
  assert.ok(src.indexOf("secretMatches") < src.indexOf("req.json"));
  assert.doesNotMatch(src, /console\.(log|error)\(.*push/);
  const lib = readFileSync("src/lib/hr-credentials.ts", "utf8");
  assert.match(lib, /revoke_staff_sessions/);
  assert.match(lib, /eq\("hr_employee_id"/);
});

test("บัญชี admin ที่ admin จับคู่เองใน dropdown รับรหัสจาก HR ได้ (ไม่มีการบล็อกตาม role)", () => {
  const lib = readFileSync("src/lib/hr-credentials.ts", "utf8");
  assert.doesNotMatch(lib, /role/);
});

// ---------------------------------------------------------------------------
// บั๊ก: updateUserById({ password_hash }) ถูก Supabase เพิกเฉย → เขียน encrypted_password ผ่าน set_staff_password_hash
// ---------------------------------------------------------------------------
const { resetDb, state } = await import(fake("admin"));
const { applyHrCredential } = await import("../src/lib/hr-credentials.ts");
const { importHrEmployees } = await import("../src/lib/hr-sync.ts");
const { toLoginEmail, STAFF_EMAIL_DOMAIN } = await import("../src/lib/staff-login.ts");
const STAFF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const seedStaff = (extra = {}) => {
  resetDb({ staff: [{ id: STAFF, role: "agent", active: true, display_name: "เอ", username: "emp003", hr_employee_id: ID, must_change_password: true, ...extra }] });
  state.authUsers = [{ id: STAFF, email: "emp003@staff.docdesk.local", encrypted_password: "random-at-create" }];
};

test("applyHrCredential: เขียน hash ลง encrypted_password (rpc set_staff_password_hash) · ไม่ต้องเปลี่ยนรหัส · ล้าง session · ไม่ใช้ updateUserById", async () => {
  seedStaff();
  assert.equal(await applyHrCredential({ hr_employee_id: ID, password_hash: HASH }), "updated");
  assert.equal(state.authUsers[0].encrypted_password, HASH, "รหัสเปลี่ยนจริง");
  assert.deepEqual(state.passwordHashSets, [STAFF]);
  assert.equal(state.passwordChanges.length, 0, "ไม่เรียก updateUserById");
  assert.equal(state.tables.staff[0].must_change_password, false);
  assert.ok(state.revoked.includes(STAFF));
  const lib = readFileSync("src/lib/hr-credentials.ts", "utf8");
  assert.doesNotMatch(lib, /db\.auth\.admin\.updateUserById/, "ไม่เรียก updateUserById (มีแค่ในคอมเมนต์อธิบาย)");
  assert.match(lib, /rpc\("set_staff_password_hash", \{ p_user: id, p_hash: push\.password_hash \}\)/);
  assert.match(lib, /if \(error \|\| set !== true\) return "failed";/);
});

test("applyHrCredential: ฟังก์ชันคืน false (ไม่พบผู้ใช้ใน auth) = failed ไม่ล้าง session ไม่แก้ must_change_password", async () => {
  seedStaff();
  state.authUsers = [];
  assert.equal(await applyHrCredential({ hr_employee_id: ID, password_hash: HASH }), "failed");
  assert.equal(state.tables.staff[0].must_change_password, true);
  assert.equal(state.revoked.length, 0);
  seedStaff({ active: false });
  assert.equal(await applyHrCredential({ hr_employee_id: ID, password_hash: HASH }), "inactive");
  resetDb({ staff: [] });
  assert.equal(await applyHrCredential({ hr_employee_id: ID, password_hash: HASH }), "unmatched");
});

test("migration 069: security definer · ตรวจรูปแบบ bcrypt · service_role เท่านั้น", () => {
  const sql = readFileSync("supabase/migrations/069_staff_password_hash.sql", "utf8");
  assert.match(sql, /function public\.set_staff_password_hash\(p_user uuid, p_hash text\) returns boolean/);
  assert.match(sql, /security definer set search_path = ''/);
  assert.match(sql, /update auth\.users set encrypted_password = p_hash, updated_at = now\(\) where id = p_user;/);
  assert.match(sql, /revoke all on function public\.set_staff_password_hash\(uuid, text\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.set_staff_password_hash\(uuid, text\) to service_role;/);
});

test("บัญชีที่ HR sync สร้าง: อีเมล = toLoginEmail ของชื่อผู้ใช้ (พิมพ์ emp003 ที่หน้า login แล้วเข้าได้)", async () => {
  resetDb({ staff: [] });
  state.authUsers = [];
  const r = await importHrEmployees([{ id: ID, employee_code: "EMP003", title: null, first_name: "สมใจ", last_name: null, full_name: "สมใจ", nickname: null, email: "", position: null, employment_status: "active" }]);
  assert.equal(r.created, 1);
  const user = state.authUsers.find((u) => u.email?.endsWith(`@${STAFF_EMAIL_DOMAIN}`));
  assert.equal(user.email, toLoginEmail("emp003"));
  assert.equal(user.email, toLoginEmail(" EMP003 "), "พิมพ์ตัวใหญ่/เว้นวรรคก็ได้");
  assert.equal(state.tables.staff[0].username, "emp003");
});
