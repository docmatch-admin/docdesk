import { createHash } from "node:crypto";
import { callModel } from "./ai";
import { supabaseAdmin } from "./supabase/admin";
import { looksThai } from "./translate";

/**
 * ใบนัด English: แปลเฉพาะข้อความที่เจ้าหน้าที่พิมพ์ (เหตุผลนัด การปฏิบัติตัว หมายเหตุ ชื่อชุดนัด)
 * เรียกเฉพาะตอนผู้ใช้กด EN บนหน้าพิมพ์ ไม่ส่งชื่อ HN หรือเบอร์คนไข้
 * ส่วนตายตัวของใบ (หัว label วันที่ ช่วงเวลา QR ท้ายใบ) เขียนไว้ในโค้ด ไม่แปลด้วย AI
 */
export const SLIP_FIELDS = ["purpose", "instructions", "note", "title"] as const;
export type SlipField = (typeof SLIP_FIELDS)[number];
export type SlipTexts = Partial<Record<SlipField, string>>;

export const SLIP_TRANSLATE_SYSTEM = `You translate short texts printed on a Thai medical clinic's appointment slip for patients.
Translate each Thai item into short, clear English for patients.
Keep every number, unit and time exactly as in the original (e.g. 8–12, 2 tablets, 09:00).
Do not add medical advice, warnings or details that are not in the original. Do not explain.
Medicine names and proper nouns stay as written.
Return JSON: {"items": {"<id>": "<English>"}} with the same ids.`;

const norm = (t: string) => t.trim().replace(/\s+/g, " ");
export const sourceHash = (t: string) => createHash("sha256").update(norm(t)).digest("hex");

/** ตัวเลขทุกชุดในต้นฉบับต้องอยู่ในคำแปลครบ (ไม่งั้นถือว่าแปลไม่สำเร็จ ให้แก้เอง) */
export function keepsNumbers(source: string, text: string): boolean {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const n of s.match(/\d+(?:[.,:]\d+)*/g) ?? []) m.set(n, (m.get(n) ?? 0) + 1);
    return m;
  };
  const want = count(source);
  const got = count(text);
  return [...want].every(([n, c]) => (got.get(n) ?? 0) >= c);
}

export async function translateSlipTexts(texts: SlipTexts): Promise<{ en: SlipTexts; failed: SlipField[] }> {
  const en: SlipTexts = {};
  const failed: SlipField[] = [];
  const pending = new Map<string, { source: string; fields: SlipField[] }>();
  for (const f of SLIP_FIELDS) {
    const source = texts[f]?.trim();
    if (!source) continue;
    // ไม่ใช่ภาษาไทย (พิมพ์อังกฤษมาแล้ว) ใช้ตามเดิม
    if (!looksThai(source) || !/[฀-๿]/.test(source)) { en[f] = source; continue; }
    const h = sourceHash(source);
    const p = pending.get(h) ?? { source, fields: [] };
    p.fields.push(f);
    pending.set(h, p);
  }
  if (!pending.size) return { en, failed };

  const db = supabaseAdmin();
  const { data: cached } = await db.from("slip_translations").select("source_hash, text_en").in("source_hash", [...pending.keys()]);
  for (const r of (cached ?? []) as { source_hash: string; text_en: string }[]) {
    for (const f of pending.get(r.source_hash)?.fields ?? []) en[f] = r.text_en;
    pending.delete(r.source_hash);
  }
  if (!pending.size) return { en, failed };

  const ids = [...pending.keys()];
  let out: Record<string, unknown> = {};
  try {
    const res = await callModel<{ items?: Record<string, unknown> }>({
      task: "translate",
      temperature: 0,
      system: SLIP_TRANSLATE_SYSTEM,
      user: JSON.stringify({ items: Object.fromEntries(ids.map((h, i) => [String(i + 1), pending.get(h)!.source])) }),
    });
    out = res?.items ?? {};
  } catch (e) {
    console.error("slip translate failed", e instanceof Error ? e.message : e);
  }
  const rows: { source_hash: string; source: string; text_en: string; edited: boolean; updated_at: string }[] = [];
  ids.forEach((h, i) => {
    const p = pending.get(h)!;
    const t = typeof out[String(i + 1)] === "string" ? (out[String(i + 1)] as string).trim().slice(0, 2000) : "";
    if (!t || !keepsNumbers(p.source, t)) { failed.push(...p.fields); return; }
    for (const f of p.fields) en[f] = t;
    rows.push({ source_hash: h, source: p.source.slice(0, 2000), text_en: t, edited: false, updated_at: new Date().toISOString() });
  });
  if (rows.length) {
    const { error } = await db.from("slip_translations").upsert(rows, { onConflict: "source_hash", ignoreDuplicates: true });
    if (error) console.error("slip translation cache failed", error.code);
  }
  return { en, failed };
}

/** พนักงานแก้คำแปลใน preview: ใช้คำที่แก้เป็นค่าใน cache ครั้งถัดไป */
export async function saveSlipTranslation(source: string, text: string): Promise<void> {
  const t = text.trim().slice(0, 2000);
  if (!source.trim() || !t) return;
  const { error } = await supabaseAdmin().from("slip_translations").upsert({
    source_hash: sourceHash(source), source: source.trim().slice(0, 2000), text_en: t, edited: true, updated_at: new Date().toISOString(),
  }, { onConflict: "source_hash" });
  if (error) throw error;
}
