// แปลงข้อมูลจาก iService เป็นแถวของ cache (ฟังก์ชันล้วน ไม่ใช้ Deno · เทสต์ด้วย node ได้)
// ข้อมูลคนไข้: เจ้าหน้าที่เห็นเท่านั้น ไม่ส่งเข้า AI

const text = (v: unknown) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

/**
 * การวินิจฉัยจาก ovst_list: pdx = รหัส ICD-10 · dx_name = ชื่อโรค (ตรวจกับข้อมูลจริง 20 พ.ย. 2026)
 * ทั้งคู่ = "K30 Functional dyspepsia" · มีแต่รหัส = "K30" · มีแต่ชื่อ = ชื่อ · ไม่มี = ""
 */
export function formatDiagnosis(code: unknown, name: unknown): string {
  const c = text(code).toUpperCase();
  const n = text(name);
  if (c && n) return n.toUpperCase().startsWith(c) ? n : `${c} ${n}`;
  return c || n;
}

/** s_qty ของ summary_drug เป็น "15 TAB" / "1 BOT" / "2.5 ML" → จำนวน + หน่วย */
export function parseDrugQty(raw: unknown): { qty: number | null; unit: string | null } {
  const s = text(raw);
  const m = s.match(/^(-?\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (!m) return { qty: null, unit: s || null };
  return { qty: Number(m[1].replace(",", ".")), unit: m[2].trim() || null };
}

export interface DrugRow { vn: string; icode: string; drug_name: string; qty: number | null; unit: string | null; usage_text: string | null; visit_date: string }

/**
 * แถวจาก summary_drug (data.data) → ยาต่อ VN: เฉพาะ drug_type "ยา" · icode เดียวกันใน VN เดียวกันรวมจำนวน
 * summary_drug ไม่มีช่องวิธีใช้ (usage_text ว่าง)
 */
export function drugsFromSummary(rows: Record<string, unknown>[]): DrugRow[] {
  const out = new Map<string, DrugRow>();
  for (const r of rows) {
    if (text(r.drug_type) && text(r.drug_type) !== "ยา") continue;
    const vn = text(r.vn), icode = text(r.icode), name = text(r.drugname ?? r.drug_name ?? r.name);
    if (!vn || !icode || !name) continue;
    const { qty, unit } = parseDrugQty(r.s_qty ?? r.qty);
    const key = `${vn}|${icode}`;
    const cur = out.get(key);
    if (cur) {
      cur.qty = cur.qty == null || qty == null ? (cur.qty ?? qty) : cur.qty + qty;
      continue;
    }
    out.set(key, { vn, icode, drug_name: name.slice(0, 200), qty, unit: unit?.slice(0, 30) ?? null, usage_text: text(r.usage ?? r.usage_text ?? r.drugusage) || null, visit_date: text(r.vstdate).slice(0, 10) });
  }
  return [...out.values()];
}

/** แถวของ summary_drug อยู่ที่ data.data */
export function summaryRows(json: unknown): Record<string, unknown>[] {
  const inner = (json as { data?: { data?: unknown } } | null)?.data?.data;
  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
}

/** ช่วงวันที่ [from, to] ทีละไม่เกิน days วัน (ดึงย้อนหลังทีละก้อน) */
export function dateChunks(from: string, to: string, days = 31): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  for (let s = day(from); s <= day(to); s += days * 86_400_000) out.push({ from: fmt(s), to: fmt(Math.min(day(to), s + (days - 1) * 86_400_000)) });
  return out;
}
