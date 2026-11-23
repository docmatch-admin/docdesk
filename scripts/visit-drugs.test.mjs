// ประวัติที่คลินิก: โรคที่มา (ovst_list pdx + dx_name) และยาที่ได้ต่อครั้ง (summary_drug) · npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fake } from "./fakes/hooks.mjs";

const { resetDb, state } = await import(fake("admin"));
const rec = await import("../supabase/functions/_shared/his-records.ts");
const { visitHistoryOf } = await import("../src/lib/visit-history.ts");

beforeEach(() => {
  resetDb({
    contacts: [{ id: "ct1", channel_id: "line", external_id: "U1", hn: "000004867" }],
    conversations: [{ id: "conv1", contact_id: "ct1", channel_id: "line", status: "open" }],
    patient_links: [{ conversation_id: "conv1", hn: "000004867", role: "patient", linked_at: "2026-11-01T00:00:00Z" }],
    his_visit_cache: [
      { vn: "691120123600", hn: "000004867", visit_date: "2026-11-20", doctor_name: "นพ. ก", diagnosis: null, rights: null, age_y: null },
      { vn: "691101090000", hn: "000004867", visit_date: "2026-11-01", doctor_name: "นพ. ก", diagnosis: "J029 Acute pharyngitis", rights: null, age_y: null },
    ],
    his_visit_drug_cache: [
      { vn: "691120123600", icode: "1001687", drug_name: "VITAMIN C 100 MG", qty: 15, unit: "TAB", usage_text: null, visit_date: "2026-11-20" },
      { vn: "691101090000", icode: "1", drug_name: "AMOXICILLIN 500 MG", qty: "20", unit: "CAP", usage_text: null, visit_date: "2026-11-01" },
      { vn: "691101090000", icode: "2", drug_name: "PARACETAMOL 500 MG", qty: 10, unit: "TAB", usage_text: null, visit_date: "2026-11-01" },
      { vn: "999", icode: "3", drug_name: "คนอื่น", qty: 1, unit: "TAB", usage_text: null, visit_date: "2026-11-01" },
    ],
  });
});

test("การวินิจฉัย: รหัส + ชื่อ · รหัสอย่างเดียว · ชื่ออย่างเดียว · ไม่มี", () => {
  assert.equal(rec.formatDiagnosis("k30", "Functional dyspepsia"), "K30 Functional dyspepsia");
  assert.equal(rec.formatDiagnosis("J029", ""), "J029");
  assert.equal(rec.formatDiagnosis("", "Acute pharyngitis"), "Acute pharyngitis");
  assert.equal(rec.formatDiagnosis("K30", "K30 Functional dyspepsia"), "K30 Functional dyspepsia", "ชื่อมีรหัสนำอยู่แล้ว ไม่ซ้ำ");
  assert.equal(rec.formatDiagnosis(null, undefined), "");
  const src = readFileSync("supabase/functions/_shared/iservice.ts", "utf8");
  assert.match(src, /formatDiagnosis\(pick\(r, \["pdx"/, "อ่าน pdx (รหัส) ตามข้อมูลจริง");
});

test("summary_drug: s_qty \"15 TAB\" → จำนวน + หน่วย · เฉพาะยา · icode ซ้ำใน VN เดียวรวมกัน · ไม่มีวิธีใช้", () => {
  assert.deepEqual(rec.parseDrugQty("15 TAB"), { qty: 15, unit: "TAB" });
  assert.deepEqual(rec.parseDrugQty("2.5 ML"), { qty: 2.5, unit: "ML" });
  assert.deepEqual(rec.parseDrugQty("3"), { qty: 3, unit: null });
  assert.deepEqual(rec.parseDrugQty(""), { qty: null, unit: null });
  const rows = rec.drugsFromSummary(rec.summaryRows({ data: { summary: {}, data: [
    { vn: "1", vstdate: "2026-11-20", icode: "A", drugname: "IBUPROFEN 400 MG", drug_type: "ยา", s_qty: "10 TAB", pt_name: "ห้ามเก็บ" },
    { vn: "1", vstdate: "2026-11-20", icode: "A", drugname: "IBUPROFEN 400 MG", drug_type: "ยา", s_qty: "5 TAB" },
    { vn: "1", vstdate: "2026-11-20", icode: "S", drugname: "ผ้าก๊อซ", drug_type: "เวชภัณฑ์", s_qty: "1 PCS" },
    { vn: "", icode: "X", drugname: "ไม่มี VN", drug_type: "ยา", s_qty: "1 TAB" },
  ] } }));
  assert.deepEqual(rows, [{ vn: "1", icode: "A", drug_name: "IBUPROFEN 400 MG", qty: 15, unit: "TAB", usage_text: null, visit_date: "2026-11-20" }]);
  assert.ok(!JSON.stringify(rows).includes("ห้ามเก็บ"), "ไม่เก็บชื่อคนไข้");
  assert.deepEqual(rec.summaryRows({ data: [] }), []);
});

test("ย้อนหลังทีละก้อน ≤ 31 วัน", () => {
  const c = rec.dateChunks("2026-01-01", "2026-03-05", 31);
  assert.deepEqual(c[0], { from: "2026-01-01", to: "2026-01-31" });
  assert.equal(c.at(-1).to, "2026-03-05");
  assert.equal(c.length, 3);
  assert.deepEqual(rec.dateChunks("2026-11-20", "2026-11-20"), [{ from: "2026-11-20", to: "2026-11-20" }]);
});

test("visits API: ยาของทุก VN ในหน้ามากับประวัติ (query เดียว in vn) · ของคนอื่นไม่ปน", async () => {
  const h = await visitHistoryOf("conv1");
  assert.deepEqual(h.visits.map((v) => v.vn), ["691120123600", "691101090000"]);
  assert.deepEqual(h.visits[0].drugs, [{ name: "VITAMIN C 100 MG", qty: 15, unit: "TAB", usage: null }]);
  assert.deepEqual(h.visits[1].drugs.map((d) => d.name), ["AMOXICILLIN 500 MG", "PARACETAMOL 500 MG"]);
  assert.equal(h.visits[1].drugs[0].qty, 20, "numeric จากฐานข้อมูลเป็นตัวเลข");
  assert.equal(h.visits[0].diagnosis, null);
  const src = readFileSync("src/lib/visit-history.ts", "utf8");
  assert.match(src, /from\("his_visit_drug_cache"\)[^\n]*\.in\("vn", rows\.map\(\(r\) => r\.vn\)\)/);
  assert.doesNotMatch(src, /for \(const (r|v) of rows\)[\s\S]{0,80}his_visit_drug_cache/, "ไม่วนถามทีละ VN");
});

test("UI: แถวแรก วันที่·แพทย์ · แถวสอง โรค (ตัวหนา) · แถวสาม ยา 3 รายการ + \"+ อีก N รายการ\" · ไม่มีข้อมูล = ไม่แสดงแถว · ชื่อยาบรรทัดเดียว", async () => {
  const ui = readFileSync("src/app/(staff)/inbox/visit-history.tsx", "utf8");
  assert.match(ui, /\{v\.diagnosis && <div className="visit-dx/);
  assert.match(ui, /if \(!drugs\.length\) return null;/);
  assert.match(ui, /const DRUGS_SHOWN = 3;/);
  assert.match(ui, /\+ อีก \$\{drugs\.length - DRUGS_SHOWN\} รายการ/);
  assert.match(ui, /sensitive-blur/, "แชทลับยังเบลอ");
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.visit-dx \{ font-weight: 600; \}/);
  assert.match(css, /\.visit-drugs li\.one \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/);
  // drugLabel อยู่ในไฟล์ client: ตรวจรูปแบบผ่านฟังก์ชันเดียวกันที่คัดลอกมา (ไฟล์ .tsx import ใน node ไม่ได้)
  assert.match(ui, /`\$\{d\.name\} × \$\{Number\.isInteger\(d\.qty\) \? d\.qty : d\.qty\.toFixed\(1\)\}\$\{d\.unit \? ` \$\{d\.unit\}` : ""\}`/);
});

test("ข้อมูลคนไข้: ตารางยาอ่านตรงด้วย login เจ้าหน้าที่ไม่ได้ · ไม่ส่งเข้า AI · cache 1 ปี · เติมการวินิจฉัยไม่เขียนทับ", () => {
  const sql = readFileSync("supabase/migrations/068_visit_drugs.sql", "utf8");
  assert.match(sql, /primary key \(vn, icode\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on his_visit_drug_cache from anon, authenticated;/);
  assert.doesNotMatch(sql, /grant select/);
  const cache = readFileSync("supabase/functions/_shared/his-cache.ts", "utf8");
  assert.match(cache, /from\("his_visit_drug_cache"\)\.delete\(\)\.lt\("visit_date", cutoff\)/, "ลบยาเก่ากว่า 1 ปี");
  assert.match(cache, /\.update\(\{ diagnosis: [^}]+\}\)\.eq\("vn", v\.vn\)\.is\("diagnosis", null\)/, "ไม่เขียนทับค่าที่มี");
  for (const f of ["src/lib/suggest.ts", "src/lib/ai.ts", "src/lib/pipeline.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /his_visit_drug_cache|visit-history|visitHistoryOf/, `${f} ไม่อ่านประวัติ/ยา`);
  }
  const fn = readFileSync("supabase/functions/iservice/index.ts", "utf8");
  assert.match(fn, /drugsBetween\(today, today\)/, "ยาของวันนี้ดึงในรอบ cron เดียวกับ ovst_list");
  assert.match(fn, /if \(b\.action === "backfill"\) \{\s*if \(!isServer\) return json\(\{ error: "forbidden" \}, 403\);/);
});
