import { createHash } from "node:crypto";
import { callModel } from "./ai";
import { aiErrorSummary } from "./ai-params";
import { EN_PHRASES, type AppointmentSettings, type LanguagePack, type PhraseKey, type Phrases } from "./appointment-rules";
import { keepsNumbers, translateSlipTexts } from "./slip-translate";
import { supabaseAdmin } from "./supabase/admin";

/**
 * ข้อความนัดตามภาษาของลูกค้า
 * - ไทย: ใช้ฉบับไทยตามเดิม (ไม่เรียกฟังก์ชันนี้)
 * - อังกฤษ: วลีอังกฤษในโค้ด + เหตุผลนัด/การปฏิบัติตัวแปลเป็นอังกฤษ (cache เดียวกับปุ่ม EN ของใบนัด)
 * - ภาษาอื่น: แปลชุดวลี + template อังกฤษ "ครั้งเดียวต่อภาษา" เมื่อมีลูกค้าภาษาใหม่ แล้วเก็บใน appointment_translations
 *   (แปลใหม่เฉพาะเมื่อแก้ template อังกฤษในตั้งค่า) · ข้อความที่เจ้าหน้าที่พิมพ์แปลครั้งเดียวต่อข้อความต่อภาษา
 * ไม่ส่งชื่อ HN หรือเบอร์คนไข้ให้ AI: ชื่อ วันที่ เวลา เบอร์ เป็น {ตัวแปร} ที่ระบบเติมหลังแปล
 * AI ล่ม/แปลไม่ผ่านการตรวจ = ใช้ฉบับอังกฤษ (ไม่กันการส่งนัด)
 */
const CACHE = "appointment_translations";
const PACK_VERSION = "pack:v1";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (t: string) => t.trim().replace(/\s+/g, " ");

export function languageName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code; } catch { return code; }
}

function localeFor(code: string): string | undefined {
  try { return Intl.DateTimeFormat.supportedLocalesOf([code]).length ? code : undefined; } catch { return undefined; }
}

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join("|");
/** คำแปลต้องมี {ตัวแปร} ครบเท่าต้นฉบับ และตัวเลขครบ */
export const validTranslation = (source: string, out: unknown): out is string =>
  typeof out === "string" && !!out.trim() && placeholders(source) === placeholders(out) && keepsNumbers(source, out);

async function cacheGet(lang: string, keys: string[]): Promise<Map<string, unknown>> {
  if (!keys.length) return new Map();
  const { data, error } = await supabaseAdmin().from(CACHE).select("source_hash, payload").eq("lang", lang).in("source_hash", keys);
  if (error) { console.error("appointment translation cache read", error.code); return new Map(); }
  return new Map(((data ?? []) as { source_hash: string; payload: unknown }[]).map((r) => [r.source_hash, r.payload]));
}

async function cachePut(rows: { lang: string; source_hash: string; source: string; payload: unknown }[]) {
  if (!rows.length) return;
  const { error } = await supabaseAdmin().from(CACHE).upsert(rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: "lang,source_hash" });
  if (error) console.error("appointment translation cache write", error.code);
}

const PACK_SYSTEM = (language: string) => `You translate the fixed wording of a medical clinic's appointment messages (sent by LINE/Facebook chat) from English into ${language}.
Translate every value naturally and politely for patients. Keep it short like the original.
Keep every {placeholder} exactly as written (do not translate or remove them), keep emojis, numbers and line breaks (\\n).
Return JSON: {"items": {"<key>": "<${language}>"}} with exactly the same keys.`;

/** วลีทั้งชุดของภาษา (แปลครั้งเดียวต่อภาษา/ต่อ template อังกฤษ) */
async function phrasesFor(code: string, templateEn: string): Promise<{ phrases: Phrases; template: string } | null> {
  const source: Record<string, string> = { ...EN_PHRASES, template: templateEn };
  const key = hash(`${PACK_VERSION}:${JSON.stringify(source)}`);
  const cached = (await cacheGet(code, [key])).get(key) as Record<string, string> | undefined;
  let items: Record<string, unknown> | undefined = cached;
  if (!items) {
    try {
      const res = await callModel<{ items?: Record<string, unknown> }>({
        task: "translate", temperature: 0, system: PACK_SYSTEM(languageName(code)), user: JSON.stringify({ items: source }),
      });
      items = res?.items;
    } catch (e) {
      console.error("appointment language pack failed", code, aiErrorSummary(e));
      return null;
    }
    if (!items) return null;
    const checked = Object.fromEntries(Object.entries(source).map(([k, en]) => [k, validTranslation(en, items![k]) ? (items![k] as string).trim() : en]));
    await cachePut([{ lang: code, source_hash: key, source: "phrases", payload: checked }]);
    items = checked;
  }
  const phrases = Object.fromEntries((Object.keys(EN_PHRASES) as PhraseKey[]).map((k) =>
    [k, validTranslation(EN_PHRASES[k], items![k]) ? (items![k] as string) : EN_PHRASES[k]])) as Phrases;
  const template = validTranslation(templateEn, items.template) ? (items.template as string) : templateEn;
  return { phrases, template };
}

const TEXT_SYSTEM = (language: string) => `You translate short texts written by a Thai clinic's staff on a patient's appointment (reason for the visit, how to prepare) into ${language}.
Translate clearly for patients. Keep every number, unit and time exactly as in the original (e.g. 8–12, 2 tablets, 09:00).
Do not add advice or details that are not in the original. Medicine names and proper nouns stay as written.
Return JSON: {"items": {"<id>": "<${language}>"}} with the same ids.`;

/** ข้อความที่เจ้าหน้าที่พิมพ์ (ไทย) → ภาษาของลูกค้า แปลครั้งเดียวต่อข้อความต่อภาษา */
async function staffTexts(code: string, texts: { purpose?: string | null; instructions?: string | null }): Promise<LanguagePack["texts"]> {
  const fields = (["purpose", "instructions"] as const).filter((f) => texts[f]?.trim());
  if (!fields.length) return {};
  // อังกฤษเป็นทางสำรองของทุกภาษา (cache เดียวกับใบนัด EN)
  const en = (await translateSlipTexts({ purpose: texts.purpose ?? undefined, instructions: texts.instructions ?? undefined })).en;
  if (code === "en") return { purpose_text: en.purpose, instructions: en.instructions };
  const keys = Object.fromEntries(fields.map((f) => [f, hash(`text:${norm(texts[f]!)}`)])) as Record<string, string>;
  const cached = await cacheGet(code, Object.values(keys));
  const got: Partial<Record<"purpose" | "instructions", string>> = {};
  const missing = fields.filter((f) => {
    const hit = cached.get(keys[f]) as { text?: string } | undefined;
    if (hit?.text) { got[f] = hit.text; return false; }
    return true;
  });
  if (missing.length) {
    let items: Record<string, unknown> = {};
    try {
      const res = await callModel<{ items?: Record<string, unknown> }>({
        task: "translate", temperature: 0, system: TEXT_SYSTEM(languageName(code)),
        user: JSON.stringify({ items: Object.fromEntries(missing.map((f) => [f, norm(texts[f]!)])) }),
      });
      items = res?.items ?? {};
    } catch (e) {
      console.error("appointment text translate failed", code, aiErrorSummary(e));
    }
    const rows: { lang: string; source_hash: string; source: string; payload: unknown }[] = [];
    for (const f of missing) {
      const src = norm(texts[f]!);
      const t = items[f];
      if (typeof t === "string" && t.trim() && keepsNumbers(src, t)) {
        got[f] = t.trim().slice(0, 2000);
        rows.push({ lang: code, source_hash: keys[f], source: src.slice(0, 2000), payload: { text: got[f] } });
      } else {
        got[f] = en[f];
      }
    }
    await cachePut(rows);
  }
  return { purpose_text: got.purpose, instructions: got.instructions };
}

/** ชุดภาษาสำหรับแชทที่ไม่ใช่ไทย (ภาษาไทย/ไม่รู้ภาษา = null) */
export async function languagePack(
  language: string | null | undefined,
  settings: Pick<AppointmentSettings, "template_en">,
  texts: { purpose?: string | null; instructions?: string | null } = {},
): Promise<LanguagePack | null> {
  const code = (language ?? "").trim().toLowerCase();
  if (!code || code === "th") return null;
  const base = code === "en" || code.startsWith("en-") ? "en" : code;
  const textsOut = await staffTexts(base, texts).catch((e) => { console.error("appointment texts", e); return {}; });
  if (base === "en") return { lang: "en", phrases: { ...EN_PHRASES }, template: settings.template_en, texts: textsOut };
  const translated = await phrasesFor(base, settings.template_en).catch((e) => { console.error("appointment phrases", e); return null; });
  if (!translated) return { lang: "en", phrases: { ...EN_PHRASES }, template: settings.template_en, texts: textsOut };
  return { lang: base, ...translated, locale: localeFor(base), texts: textsOut };
}
