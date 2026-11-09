// พารามิเตอร์ OpenAI ตามชนิดโมเดล และข้อความลูกค้าต้องเข้า inbox แม้ AI ล้ม: npm test
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

process.env.OPENAI_API_KEY = "sk-test";
const { calls } = await import(fake("ai"));
const { resetDb, state } = await import(fake("admin"));
const { chatParams, effortFor, isReasoningModel, unsupportedParam } = await import("../src/lib/ai-params.ts");
// import ตรงจาก scripts/ จึงได้ ai.ts ตัวจริง (ไม่ผ่าน fake) เพื่อทดสอบการลองใหม่
const real = await import("../src/lib/ai.ts");
const { storeIncoming } = await import("../src/lib/pipeline.ts");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("แยกโมเดล reasoning", () => {
  for (const m of ["gpt-5", "gpt-5-mini", "gpt-5.1", "o1-mini", "o3", "o4-mini"]) assert.equal(isReasoningModel(m), true, m);
  for (const m of ["gpt-4o-mini", "gpt-4.1", "gpt-4.1-nano"]) assert.equal(isReasoningModel(m), false, m);
});

test("โมเดล reasoning: ไม่ส่ง temperature ใช้ max_completion_tokens และ reasoning_effort ตามงาน", () => {
  const p = chatParams({ model: "gpt-5-mini", task: "translate", temperature: 0 });
  assert.equal("temperature" in p, false);
  assert.equal("max_tokens" in p, false);
  assert.ok(p.max_completion_tokens >= 2000, "เผื่อ token ให้การคิด");
  assert.equal(p.reasoning_effort, "minimal");
  assert.equal(chatParams({ model: "gpt-5-mini", task: "draft" }).reasoning_effort, "low");
  assert.equal(effortFor("translate", "gpt-5.1"), "low", "รุ่นที่ไม่รองรับ minimal");
  assert.equal(effortFor("tag", "o3"), "low");
  for (const k of ["top_p", "presence_penalty", "frequency_penalty"]) assert.equal(k in p, false);
});

test("โมเดลอื่น: ส่ง temperature และ max_tokens ตามเดิม", () => {
  assert.deepEqual(chatParams({ model: "gpt-4o-mini", task: "translate", temperature: 0 }), { model: "gpt-4o-mini", max_tokens: 1200, temperature: 0 });
});

test("อ่านชื่อพารามิเตอร์จาก error 400", () => {
  assert.deepEqual(unsupportedParam({ status: 400, param: "temperature", message: "400 Unsupported value: 'temperature' does not support 0 with this model." }),
    { param: "temperature", message: "400 Unsupported value: 'temperature' does not support 0 with this model." });
  assert.equal(unsupportedParam({ status: 500, message: "boom" }), null);
  assert.equal(unsupportedParam({ status: 400, message: "Invalid JSON" }), null);
});

test("callModel: โมเดลไม่รับ reasoning_effort minimal → log ชัดแล้วลองใหม่ด้วย low", async () => {
  const bodies = [];
  const logs = [];
  const origError = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_value" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "{\"th\":\"สวัสดี\",\"language\":\"en\"}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    resetDb({});
    const out = await real.callModel({ task: "translate", system: "s", user: "hello", temperature: 0, model: "gpt-5-mini" });
    assert.deepEqual(out, { th: "สวัสดี", language: "en" });
  } finally {
    console.error = origError;
  }
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].reasoning_effort, "minimal");
  assert.equal(bodies[1].reasoning_effort, "low");
  assert.equal("temperature" in bodies[0], false);
  assert.ok(logs.some((l) => /unsupported parameter "reasoning_effort" for model gpt-5-mini/.test(l)), logs.join("\n"));
});

test("AI แปลไม่ได้: ข้อความลูกค้ายังเข้า inbox และ error ไม่ถูกนับเป็น error ของ webhook", async () => {
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "line", type: "line", name: "LINE", ai_mode: null, enabled: true, created_at: "2026-11-01T00:00:00Z" }],
    contacts: [], conversations: [], tags: [], tag_rules: [], tag_events: [], bookings: [], system_errors: [],
  });
  calls.failNext = Object.assign(new Error("400 Unsupported value: 'temperature' does not support 0 with this model."), { status: 400 });
  const stored = await storeIncoming({ channelType: "line", externalId: "U1", text: "Hello, can I book tomorrow?", displayName: "John" });
  assert.equal(stored.duplicate, false);
  const msg = state.tables.messages.find((m) => m.id === stored.messageId);
  assert.equal(msg.body, "Hello, can I book tomorrow?");
  assert.equal(msg.body_th, null);
  assert.ok(state.tables.system_errors.some((e) => e.source === "ai:translate"));
  assert.ok(!state.tables.system_errors.some((e) => e.source.startsWith("webhook")));
});
