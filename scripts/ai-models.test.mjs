// ชื่อโมเดล AI: หน้าตั้งค่าเป็นหลัก env เป็นค่าสำรอง: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";
const { resetDb, state } = await import(fake("admin"));
const rules = await import("../src/lib/ai-models-rules.ts");
const store = await import("../src/lib/ai-models.ts");
const route = await import("../src/app/api/ai-models/route.ts");

const ENV = { OPENAI_CHAT_MODEL: "gpt-env-chat", OPENAI_EMBED_MODEL: "embed-env" };
beforeEach(() => {
  resetDb({ settings: [], staff: [{ id: "adm", role: "admin", active: true, display_name: "แอดมิน", must_change_password: false }, { id: "agent", role: "agent", active: true, display_name: "เอ", must_change_password: false }] });
  state.currentUser = { id: "adm", email: "adm@test" };
  store.clearModelCache();
});

test("ฐานข้อมูลมาก่อน env ใช้เฉพาะช่องที่ฐานข้อมูลยังไม่มีค่า", () => {
  const r = rules.resolveModels({ chat: "gpt-db", translate: null, embed: "" }, ENV);
  assert.deepEqual(r.draft, { model: "gpt-db", source: "db" });
  assert.deepEqual(r.translate, { model: "gpt-db", source: "db", inherited: true }, "แปลว่าง = ใช้โมเดลหลัก");
  assert.deepEqual(r.embed, { model: "embed-env", source: "env" });
  assert.deepEqual(rules.resolveModels({ translate: "gpt-tr" }, ENV).translate, { model: "gpt-tr", source: "db" });
  assert.deepEqual(rules.resolveModels({}, ENV).draft, { model: "gpt-env-chat", source: "env" });
  assert.deepEqual(rules.resolveModels({}, { OPENAI_MODEL: "gpt-alias" }).draft, { model: "gpt-alias", source: "env" }, "รองรับ OPENAI_MODEL");
  assert.deepEqual(rules.resolveModels(null, {}).draft, { model: "gpt-4o-mini", source: "default" });
  assert.deepEqual(rules.resolveModels(null, {}).embed, { model: "text-embedding-3-small", source: "default" });
  assert.equal(rules.resolveModels({ chat: "bad name;drop" }, {}).draft.source, "default", "ชื่อไม่ถูกต้องไม่ใช้");
});

test("API: แอดมินบันทึกโมเดล ใช้ทันที ช่องว่าง = ลบค่า (กลับไปใช้ env/ค่าเริ่มต้น) คนอื่น 403", async () => {
  const put = (body) => route.PUT(new Request("https://app.test/x", { method: "PUT", body: JSON.stringify(body) }));
  const r = await put({ chat: "gpt-5-mini", translate: "", embed: "" });
  assert.equal(r.status, 200);
  assert.deepEqual(state.tables.settings.find((s) => s.key === "ai_models").value, { chat: "gpt-5-mini", translate: null, embed: null });
  assert.equal(await store.modelFor("draft"), "gpt-5-mini");
  assert.equal(await store.modelFor("translate"), "gpt-5-mini");
  const g = await (await route.GET()).json();
  assert.equal(g.active.draft.source, "db");
  assert.equal((await put({ chat: "gpt 5; rm" })).status, 400);
  state.currentUser = { id: "agent", email: "a@test" };
  assert.equal((await put({ chat: "x" })).status, 403);
  assert.equal((await route.GET()).status, 403);
});

test("ทุกการเรียก AI อ่านโมเดลผ่าน ai-models ไม่อ่าน env ตรง", () => {
  const ai = readFileSync("src/lib/ai.ts", "utf8");
  assert.doesNotMatch(ai, /process\.env\.OPENAI_(CHAT|EMBED)_MODEL/);
  assert.match(ai, /await modelFor\(input\.task === "translate" \? "translate" : "draft"\)/);
  assert.equal((ai.match(/await modelFor\("embed"\)/g) ?? []).length, 2);
  assert.doesNotMatch(readFileSync("src/lib/health.ts", "utf8"), /EMBED_MODEL/);
});
