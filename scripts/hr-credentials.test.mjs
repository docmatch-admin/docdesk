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

test("บัญชี admin ห้าม HR ตั้งรหัสให้", () => {
  const lib = readFileSync("src/lib/hr-credentials.ts", "utf8");
  assert.ok(lib.indexOf('=== "admin") return "admin"') < lib.indexOf("password_hash: push.password_hash"));
});
