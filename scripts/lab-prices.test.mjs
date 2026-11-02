// ทดสอบราคาแล็บ: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { calls, replies, reset } = await import(fake("ai"));
const { nextTime, resetDb, state } = await import(fake("admin"));
const { storeIncoming } = await import("../src/lib/pipeline.ts");
const { generateSuggestions } = await import("../src/lib/suggest.ts");
const {
  buildLabContext, buildPriceMessage, buildQuoteMessage, compareSelection, DEFAULT_B2B_RULES, findRequestedItems,
  isLabQuestion, normalizeB2bRules, packageValue, quoteB2b,
} = await import("../src/lib/lab-pricing.ts");
const labRoute = await import("../src/app/api/lab-prices/route.ts");
const quoteRoute = await import("../src/app/api/lab-prices/quote/route.ts");

// อ่านข้อมูลจริงจาก migration เพื่อให้เทสต์ตรวจตัวเลขที่จะขึ้นระบบจริง
const seed = readFileSync("supabase/migrations/021_lab_prices.sql", "utf8");
const parseArray = (s) => (s.startsWith("'{}'") ? [] : [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]));

const ITEMS = [...seed.matchAll(/^\s*\('([A-Z0-9_]+)','([^']*)','([^']*)',(?:'([^']*)'|null),(\d+),(\d+),'([^']*)'\)/gm)]
  .map(([, code, name_en, name_th, tube, cost, price, category]) => ({ code, name_en, name_th, tube, cost: Number(cost), price: Number(price), category, active: true }));
const PACKAGES = [...seed.matchAll(/^\s*\('([A-Z0-9_]+)','([^']*)',(\d+),(\d+),(array\[.*?\]::text\[\]),(array\[.*?\]::text\[\]),(array\[.*?\]::text\[\]|'\{\}'::text\[\])\)/gm)]
  .map(([, code, name, price, cost, includes, compare, unpriced]) => ({
    code, name, price: Number(price), cost: Number(cost), includes: parseArray(includes), compare_item_codes: parseArray(compare), items_without_single_price: parseArray(unpriced), active: true,
  }));
const pkg = (code) => PACKAGES.find((p) => p.code === code);

test("อ่าน seed ครบ 44 รายการ 10 แพ็กเกจ", () => {
  assert.equal(ITEMS.length, 44);
  assert.equal(PACKAGES.length, 10);
});

// ---- ตรงกับตารางใน README ของไฟล์ราคา ----
for (const [code, price, singles, saving] of [
  ["CHK_S", 999, 1950, 951], ["CHK_F", 1300, 3100, 1800], ["CHK_M", 1399, 3400, 2001], ["ELDER", 300, 700, 400],
  ["DM", 400, 850, 450], ["HT", 400, 900, 500], ["DMHT", 600, 1150, 550], ["ANC1", 399, 1050, 651], ["ANC2", 399, 850, 451], ["LIPID_FBS", 300, 300, 0],
]) {
  test(`${code}: ซื้อแยกอย่างน้อย ${singles} ประหยัด ${saving}`, () => {
    const v = packageValue(pkg(code), ITEMS);
    assert.deepEqual([v.price, v.singlesAtLeast, v.savingAtLeast], [price, singles, saving]);
  });
}

test("แพ็กเกจแพงกว่าซื้อแยก: ประหยัดไม่ติดลบ", () => {
  assert.equal(packageValue({ ...pkg("LIPID_FBS"), price: 500 }, ITEMS).savingAtLeast, 0);
});

test("เพิ่มราคาเดี่ยวของ UA ภายหลัง: นับในยอดและไม่ขึ้นว่ายังไม่มีราคา", () => {
  const v = packageValue(pkg("CHK_S"), [...ITEMS, { code: "UA", name_en: "UA", name_th: "ปัสสาวะ", price: 50, category: "อื่นๆ", active: true }]);
  assert.equal(v.singlesAtLeast, 2000);
  assert.deepEqual(v.unpriced, []);
});

// ---- จับชื่อรายการ ----
const find = (t) => findRequestedItems(t, ITEMS);

test("จับชื่อรายการ: อังกฤษ ไทย และชื่ออื่น", () => {
  assert.deepEqual(find("อยากตรวจ CBC กับไขมัน").codes.sort(), ["CBC", "LIPID"]);
  assert.deepEqual(find("ตรวจน้ำตาลสะสมราคาเท่าไหร่").codes, ["HBA1C"]);
  assert.deepEqual(find("SGOT SGPT เท่าไหร่").codes.sort(), ["ALT", "AST"]);
  assert.deepEqual(find("ตรวจไทรอยด์").codes.sort(), ["T3", "T4", "TSH"]);
});

test("จับชื่อรายการ: คำยาวก่อน CA 19-9 ไม่กลายเป็น Calcium และ 500 mg ไม่ใช่ Magnesium", () => {
  assert.deepEqual(find("ตรวจ CA 19-9").codes, ["CA199"]);
  assert.deepEqual(find("กินยา 500 mg วันละครั้ง").codes, []);
  assert.deepEqual(find("อยากไปเที่ยว").codes, []);
});

test("จับรายการที่ไม่มีราคาเดี่ยว", () => {
  assert.deepEqual(find("ตรวจปัสสาวะราคาเท่าไหร่").unpriced, ["UA"]);
  assert.deepEqual(find("ตรวจ Potassium").unpriced, ["Potassium"]);
});

// ---- กฎคำสำคัญ ----
for (const text of ["ตรวจสุขภาพราคาเท่าไหร่", "ตรวจเลือดกี่บาท", "ราคาแล็บ", "HIV เท่าไหร่", "มีแพ็กเกจอะไรบ้าง"]) {
  test(`เกี่ยวกับแล็บ: ${text}`, () => assert.equal(isLabQuestion(text, [], ITEMS), true));
}
for (const text of ["คลินิกเปิดกี่โมง", "วัคซีนไข้หวัดใหญ่ราคาเท่าไหร่", "ที่อยู่คลินิก"]) {
  test(`ไม่เกี่ยวกับแล็บ: ${text}`, () => assert.equal(isLabQuestion(text, [], ITEMS), false));
}
test("แท็กตรวจสุขภาพทำให้ได้ข้อมูลราคา แม้ข้อความไม่มีคำสำคัญ", () => {
  assert.equal(isLabQuestion("ราคาเท่าไหร่คะ", ["ตรวจสุขภาพ"], ITEMS), true);
});

// ---- เทียบซื้อแยกกับแพ็กเกจ ----
const cmp = (codes, unpriced = []) => compareSelection(codes, unpriced, ITEMS, PACKAGES);

test("ซื้อแยกถูกกว่า: แนะนำซื้อแยก", () => {
  const c = cmp(["CBC"]);
  assert.equal(c.singlesTotal, 100);
  assert.equal(c.recommendation, "singles");
  assert.equal(c.saving, 0);
});

test("แพ็กเกจถูกกว่า: แนะนำแพ็กเกจและบอกส่วนที่ประหยัด", () => {
  const c = cmp(["FBS", "LIPID", "CR", "CBC", "URIC", "EGFR"]);
  assert.equal(c.singlesTotal, 900);
  assert.equal(c.recommendation, "package");
  assert.equal(c.cheapest.code, "HT");
  assert.equal(c.saving, 500);
});

test("ราคาเท่ากัน: แนะนำซื้อแยก ไม่ดันแพ็กเกจของกลุ่มอื่น", () => {
  const c = cmp(["LIPID", "FBS"]);
  assert.equal(c.singlesTotal, 300);
  assert.equal(c.recommendation, "singles");
});

test("ไม่มีแพ็กเกจครอบคลุม: แนะนำซื้อแยก", () => {
  const c = cmp(["INSULIN", "CD4"]);
  assert.equal(c.covering.length, 0);
  assert.equal(c.singlesTotal, 3500);
  assert.equal(c.recommendation, "singles");
});

test("มีรายการไม่มีราคาเดี่ยวและไม่มีแพ็กเกจที่ถูกกว่า: ยังสรุปไม่ได้", () => {
  const c = cmp(["INSULIN"], ["Potassium"]);
  assert.equal(c.recommendation, "ask_price");
  assert.deepEqual(c.unpriced, ["Potassium"]);
});

test("มีรายการไม่มีราคาเดี่ยว แต่แพ็กเกจถูกกว่ายอดขั้นต่ำอยู่แล้ว: แนะนำแพ็กเกจได้", () => {
  const c = cmp(["FBS", "HBA1C", "CR", "LIPID", "EGFR"], ["UA"]);
  assert.equal(c.singlesTotal, 850);
  assert.equal(c.recommendation, "package");
  assert.equal(c.cheapest.code, "DM");
});

test("แพ็กเกจที่ปิดใช้ไม่ถูกแนะนำ", () => {
  const off = PACKAGES.map((p) => ({ ...p, active: p.code !== "HT" && p.code !== "DMHT" }));
  const c = compareSelection(["FBS", "LIPID", "CR", "CBC", "URIC", "EGFR"], [], ITEMS, off);
  assert.ok(!c.covering.some((p) => p.code === "HT" || p.code === "DMHT"));
});

test("ไม่ได้เลือกอะไร: ไม่แนะนำ", () => {
  assert.equal(cmp([]).recommendation, "none");
  assert.equal(cmp([]).covering.length, 0);
});

// ---- ข้อความให้ลูกค้า ----
test("ข้อความสรุปราคา: มียอดรวมและบอกแพ็กเกจที่ถูกกว่า", () => {
  const m = buildPriceMessage(cmp(["FBS", "LIPID", "CR", "CBC", "URIC", "EGFR"]));
  assert.match(m, /รวม 900 บาท/);
  assert.match(m, /ประหยัดกว่า 500 บาท/);
});

test("ข้อความสรุปราคา: รายการเดียวไม่บอกยอดรวมซ้ำ", () => {
  assert.equal(buildPriceMessage(cmp(["CBC"])), "CBC 100 บาทค่ะ");
});

test("ข้อความสรุปราคา: รายการไม่มีราคาเดี่ยว ห้ามเดา", () => {
  const m = buildPriceMessage(cmp(["INSULIN"], ["Potassium"]));
  assert.match(m, /Potassium ขอแจ้งราคาให้ทีหลัง/);
});

test("ข้อความสรุปราคา: แพ็กเกจที่เลือกบอกยอดเทียบ", () => {
  const m = buildPriceMessage(cmp([]), [packageValue(pkg("CHK_S"), ITEMS)]);
  assert.match(m, /999 บาท.*1,950 บาท.*951 บาท/);
});

// ---- context ของ AI ----
const SECRET = 987654;
const withSecret = (rows) => rows.map((r) => ({ ...r, cost: SECRET }));

function setup(extra = {}) {
  reset();
  resetDb({
    settings: [{ key: "ai_mode", value: "off" }],
    channels: [{ id: "ch", type: "web", ai_mode: null, enabled: true, created_at: nextTime() }],
    contacts: [], conversations: [], tags: [], tag_rules: [], tag_events: [], reply_examples: [],
    lab_items: withSecret(ITEMS),
    lab_packages: withSecret(PACKAGES),
    staff: [{ id: "admin", role: "admin", active: true, display_name: "A" }, { id: "agent", role: "agent", active: true, display_name: "B" }],
    ...extra,
  });
  state.currentUser = { id: "admin", email: "a@test" };
  replies.next = { needs_human: false, suggested_tags: [], options: [{ text: "ค่ะ", source: "knowledge", ref_ids: [], confidence: 0.9 }] };
}
beforeEach(() => setup());
const ask = async (text) => {
  const s = await storeIncoming({ channelType: "web", externalId: "11111111-1111-4111-8111-111111111111", text });
  return generateSuggestions(s.conversationId);
};

test("AI context: ไม่มีต้นทุนเลย แม้แถวในฐานข้อมูลมีคอลัมน์ cost", async () => {
  await ask("ตรวจสุขภาพชุดเล็กราคาเท่าไหร่ อยากตรวจ CBC ด้วย");
  const p = calls.lastPrompt;
  assert.match(p, /ราคาแล็บ/);
  assert.ok(!p.includes(String(SECRET)), "มีตัวเลขต้นทุนหลุดเข้า prompt");
  assert.doesNotMatch(p, /\bcost\b|ต้นทุน|กำไร/i);
});

test("buildLabContext ไม่หยิบ cost แม้ได้รับแถวที่มี cost", () => {
  const c = buildLabContext("ตรวจ CBC", withSecret(ITEMS), withSecret(PACKAGES));
  assert.ok(!c.includes(String(SECRET)));
  assert.doesNotMatch(c, /cost|ต้นทุน|กำไร/i);
});

test("AI context: มียอดที่คำนวณแล้ว และกฎห้ามบวกเลข", async () => {
  await ask("ตรวจสุขภาพมีแบบไหนบ้าง");
  const p = calls.lastPrompt;
  assert.match(p, /โปรแกรมตรวจสุขภาพชุดเล็ก: 999 บาท; ซื้อแยกอย่างน้อย 1,950 บาท ประหยัดอย่างน้อย 951 บาท/);
  assert.match(p, /ห้ามบวก/);
  assert.match(p, /ห้ามเดาราคา/);
  assert.match(p, /รายการที่ยังไม่มีราคาเดี่ยว: UA/);
});

test("AI context: ลูกค้าบอกรายการ ได้ผลเทียบที่คำนวณแล้ว", async () => {
  await ask("อยากตรวจ FBS ไขมัน Creatinine CBC Uric acid eGFR");
  assert.match(calls.lastPrompt, /รวม 900 บาท/);
  assert.match(calls.lastPrompt, /ประหยัด 500 บาท/);
});

test("คำถามไม่เกี่ยว: ไม่เพิ่มข้อมูลแล็บ", async () => {
  await ask("คลินิกเปิดกี่โมงคะ");
  assert.doesNotMatch(calls.lastPrompt, /## ราคาแล็บ/);
  assert.equal(calls.chat, 1);
});

test("ตัวกันตัวเลข: รู้จักราคาและยอดที่คำนวณแล้ว", async () => {
  replies.next.options = [{ text: "ชุดเล็ก 999 บาท ซื้อแยกอย่างน้อย 1,950 บาท ประหยัด 951 บาทค่ะ", source: "knowledge", ref_ids: [], confidence: 0.95 }];
  const r = await ask("ตรวจสุขภาพชุดเล็กราคาเท่าไหร่");
  assert.equal(r.options[0].confidence, 0.95);
  assert.equal(r.options[0].note, undefined);
});

test("ตัวกันตัวเลข: AI แต่งราคาแล็บ ถูกจับ", async () => {
  replies.next.options = [{ text: "ชุดเล็ก 777 บาทค่ะ", source: "knowledge", ref_ids: [], confidence: 0.95 }];
  const r = await ask("ตรวจสุขภาพชุดเล็กราคาเท่าไหร่");
  assert.ok(r.options[0].confidence <= 0.5);
  assert.match(r.options[0].note, /777/);
});

test("ตัวกันตัวเลข: AI เดาราคา UA ถูกจับ", async () => {
  replies.next.options = [{ text: "ตรวจปัสสาวะ 88 บาทค่ะ", source: "knowledge", ref_ids: [], confidence: 0.95 }];
  const r = await ask("ตรวจปัสสาวะราคาเท่าไหร่");
  assert.ok(r.options[0].confidence <= 0.5);
});

test("ตัวกันตัวเลข: ตัวเลขแล็บใช้ได้เฉพาะเมื่อส่งข้อมูลแล็บให้ AI", async () => {
  replies.next.options = [{ text: "999 บาทค่ะ", source: "knowledge", ref_ids: [], confidence: 0.95 }];
  const r = await ask("คลินิกเปิดกี่โมงคะ");
  assert.ok(r.options[0].confidence <= 0.5);
});

const OLD_STAR = { id: "e1", question: "ตรวจสุขภาพชุดเล็กราคาเท่าไหร่", answer: "ชุดเล็ก 1,200 บาทค่ะ", starred: true, use_count: 9, created_at: "2026-01-01T00:00:00Z", similarity: 0.97 };

test("คำตอบติดดาวราคาเก่า: ไม่ข้ามราคาล่าสุด และตัวเลขเก่าถูกจับ", async () => {
  state.matchExamples = [OLD_STAR];
  replies.next.options = [{ text: "ชุดเล็ก 1,200 บาทค่ะ", source: "example", ref_ids: [], confidence: 0.95 }];
  const r = await ask("ตรวจสุขภาพชุดเล็กราคาเท่าไหร่");
  state.matchExamples = [];
  assert.equal(calls.chat, 1, "ต้องเรียก AI พร้อมราคาล่าสุด ไม่ใช้คำตอบติดดาวทันที");
  assert.match(calls.lastPrompt, /999 บาท/);
  assert.ok(r.options[0].confidence <= 0.5);
  assert.match(r.options[0].note, /1,?200/);
});

test("รายการปิดใช้: ไม่อยู่ใน context", async () => {
  state.tables.lab_items.find((i) => i.code === "CD4").active = false;
  await ask("ตรวจเลือดมีอะไรบ้าง");
  assert.doesNotMatch(calls.lastPrompt, /CD4 \(CD4\)/);
});

// ---- B2B ----
const R = DEFAULT_B2B_RULES;
test("ขั้นส่วนลดเริ่มต้น", () => {
  const p = { price: 1000, cost: 100 };
  assert.equal(quoteB2b(p, 9, R).unitPrice, 1000);
  assert.equal(quoteB2b(p, 10, R).unitPrice, 950);
  assert.equal(quoteB2b(p, 29, R).unitPrice, 950);
  assert.equal(quoteB2b(p, 30, R).unitPrice, 900);
  assert.equal(quoteB2b(p, 99, R).unitPrice, 900);
  assert.equal(quoteB2b(p, 100, R).unitPrice, 850);
});

test("กำไรรวมและยอดรวม", () => {
  const q = quoteB2b({ price: 1000, cost: 100 }, 30, R);
  assert.equal(q.total, 27000);
  assert.equal(q.unitProfit, 800);
  assert.equal(q.totalProfit, 24000);
});

test("ส่วนลดถูกจำกัดเมื่อกำไรต่อคนจะต่ำกว่าขั้นต่ำ", () => {
  // ลด 15% = 340 กำไร 40 ต่ำกว่า 150 จึงต้องเป็น 400
  const q = quoteB2b({ price: 400, cost: 300 }, 100, { ...R, minProfitPerPerson: 50 });
  assert.equal(q.unitPrice, 350);
  assert.equal(q.unitProfit, 50);
  assert.equal(q.limitedByMinProfit, true);
});

for (const p of PACKAGES) {
  for (const count of [1, 10, 30, 100, 5000]) {
    test(`${p.code} ${count} คน: กำไรต่อคนไม่ต่ำกว่าขั้นต่ำ เว้นแต่ราคาปกติต่ำกว่าอยู่แล้ว และไม่แพงกว่าราคาปกติ`, () => {
      const q = quoteB2b(p, count, R);
      assert.ok(q.unitPrice <= p.price);
      if (p.price - p.cost >= R.minProfitPerPerson) assert.ok(q.unitProfit >= R.minProfitPerPerson, JSON.stringify(q));
      else {
        assert.equal(q.unitPrice, p.price, "ราคาปกติมีกำไรต่ำกว่าขั้นต่ำอยู่แล้ว ต้องไม่ลดเพิ่ม");
        assert.equal(q.belowMinAtList, true);
      }
    });
  }
}

test("ปัดราคาขึ้น ไม่ทำให้กำไรต่ำกว่าขั้นต่ำเพราะเศษสตางค์", () => {
  const q = quoteB2b({ price: 999, cost: 499 }, 10, R);
  assert.equal(q.unitPrice, 950);
  assert.equal(Number.isInteger(q.unitPrice), true);
});

test("ข้อความเสนอราคาไม่มีต้นทุนหรือกำไร", () => {
  const q = quoteB2b(pkg("CHK_S"), 30, R);
  const m = buildQuoteMessage(pkg("CHK_S").name, q);
  assert.match(m, /30 ท่าน/);
  assert.match(m, /ท่านละ 900 บาท/);
  assert.doesNotMatch(m, /ทุน|กำไร|499/);
});

test("เกณฑ์ B2B ที่เสียใช้ค่าเริ่มต้น", () => {
  assert.deepEqual(normalizeB2bRules(null), DEFAULT_B2B_RULES);
  assert.deepEqual(normalizeB2bRules({ tiers: [{ minStaff: "x" }], minProfitPerPerson: -1 }), DEFAULT_B2B_RULES);
  assert.equal(normalizeB2bRules({ tiers: [{ minStaff: 5, percent: 20 }], minProfitPerPerson: 10 }).tiers[0].percent, 20);
});

// ---- สิทธิ์ของ API ----
const json = (method, body) => new Request("https://app.test/x", {
  method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
});

for (const [name, call] of [
  ["อ่านราคาพร้อมทุน", () => labRoute.GET()],
  ["เพิ่มรายการ", () => labRoute.POST(json("POST", { code: "X", name_en: "x" }))],
  ["แก้ราคา", () => labRoute.PATCH(json("PATCH", { kind: "item", code: "CBC", price: 1 }))],
  ["ใบเสนอราคา", () => quoteRoute.POST(json("POST", { code: "CHK_S", count: 30 }))],
]) {
  test(`agent ${name}: 403`, async () => {
    state.currentUser = { id: "agent", email: "b@test" };
    assert.equal((await call()).status, 403);
  });
  test(`ไม่ได้ล็อกอิน ${name}: 401`, async () => {
    state.currentUser = null;
    assert.equal((await call()).status, 401);
  });
}

test("admin อ่านทุนได้ และแก้ราคาได้", async () => {
  const j = await (await labRoute.GET()).json();
  assert.equal(j.items.length, 44);
  assert.equal(j.items[0].cost, SECRET);
  assert.equal((await labRoute.PATCH(json("PATCH", { kind: "item", code: "CBC", price: 120 }))).status, 200);
  assert.equal(state.tables.lab_items.find((i) => i.code === "CBC").price, 120);
});

test("แก้ราคา: ค่าที่ไม่ถูกต้องไม่ผ่าน", async () => {
  assert.equal((await labRoute.PATCH(json("PATCH", { kind: "item", code: "CBC", price: -1 }))).status, 400);
  assert.equal((await labRoute.PATCH(json("PATCH", { kind: "package", code: "CHK_S", price: null }))).status, 400);
  assert.equal((await labRoute.PATCH(json("PATCH", { kind: "x", code: "CBC" }))).status, 400);
  assert.equal((await labRoute.PATCH(json("PATCH", { kind: "item", code: "ไม่มี", price: 1 }))).status, 404);
});

test("เว้นราคาเดี่ยวได้ แปลว่ายังไม่มีราคา", async () => {
  assert.equal((await labRoute.PATCH(json("PATCH", { kind: "item", code: "CBC", price: null }))).status, 200);
  assert.equal(state.tables.lab_items.find((i) => i.code === "CBC").price, null);
});

test("เพิ่มรายการ: รหัสไม่ถูกต้องไม่ผ่าน", async () => {
  assert.equal((await labRoute.POST(json("POST", { code: "มี ช่องว่าง", name_en: "x" }))).status, 400);
  assert.equal((await labRoute.POST(json("POST", { code: "UA", name_en: "UA", price: -5 }))).status, 400);
  assert.equal((await labRoute.POST(json("POST", { code: "ua", name_en: "UA" }))).status, 200);
  assert.equal(state.tables.lab_items.at(-1).code, "UA");
});

test("ใบเสนอราคา: ใช้เกณฑ์ที่ตั้งไว้ และคืนข้อความไม่มีทุน", async () => {
  state.tables.settings.push({ key: "lab_b2b_rules", value: { tiers: [{ minStaff: 5, percent: 50 }], minProfitPerPerson: 150 } });
  state.tables.lab_packages.find((p) => p.code === "CHK_S").cost = 499;
  const j = await (await quoteRoute.POST(json("POST", { code: "CHK_S", count: 5 }))).json();
  assert.equal(j.quote.unitPrice, 649, "ลด 50% = 500 แต่กำไรต่ำกว่าขั้นต่ำ จึงเป็น 499+150");
  assert.equal(j.quote.limitedByMinProfit, true);
  assert.doesNotMatch(j.message, /499/);
});

test("ใบเสนอราคา: ข้อมูลไม่ถูกต้อง", async () => {
  assert.equal((await quoteRoute.POST(json("POST", { code: "CHK_S", count: 0 }))).status, 400);
  assert.equal((await quoteRoute.POST(json("POST", { code: "CHK_S", count: 1.5 }))).status, 400);
  assert.equal((await quoteRoute.POST(json("POST", { count: 10 }))).status, 400);
  assert.equal((await quoteRoute.POST(json("POST", { code: "ไม่มี", count: 10 }))).status, 404);
});

test("migration ให้สิทธิ์อ่านทีละคอลัมน์โดยไม่รวม cost", () => {
  const grants = [...seed.matchAll(/grant select \(([^)]*)\) on (lab_\w+) to authenticated/g)];
  assert.equal(grants.length, 2);
  for (const [, cols] of grants) assert.doesNotMatch(cols, /cost/);
  assert.match(seed, /revoke all on lab_items from anon, authenticated/);
  assert.match(seed, /update knowledge_items set active = false where title = 'แพ็กเกจตรวจสุขภาพ'/);
  assert.doesNotMatch(seed, /title = 'ตรวจคลื่นไฟฟ้าหัวใจ/);
});
