import { embedMany } from "./ai";
import { getSetting } from "./mode";
import { NO_PRICE_MARK } from "./price-catalog";
import { supabaseAdmin } from "./supabase/admin";

export interface WebsiteOption { label: string; price: number | null; note?: string | null }
export interface WebsiteProgram {
  slug: string;
  category: string;
  name: string;
  price: number | null;
  price_unit: string | null;
  price_note: string | null;
  options: WebsiteOption[];
  includes: string[];
  updated_at: string;
}

export interface PriceAlert { code: string; name: string; message: string; at: string }
export interface WebsiteSyncStatus {
  last_attempt_at: string | null;
  last_success_at: string | null;
  error: string | null;
  /** ต้องให้ admin ยืนยันก่อนปิดบริการจำนวนมาก */
  needs_confirm: boolean;
  count: number;
  alerts: PriceAlert[];
}

export const WEBSITE_SYNC_KEY = "website_sync";
export const EMPTY_SYNC_STATUS: WebsiteSyncStatus = { last_attempt_at: null, last_success_at: null, error: null, needs_confirm: false, count: 0, alerts: [] };
const SYNC_EVERY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ALERTS = 20;

const CATEGORY_TH: Record<string, string> = {
  checkup: "ตรวจสุขภาพ",
  certificate: "ใบรับรองแพทย์",
  procedure: "หัตถการ",
  "family-planning": "คุมกำเนิด",
  "sexual-health": "สุขภาพทางเพศ",
  vaccine: "วัคซีน",
};
const FALLBACK_CATEGORY = "บริการอื่นๆ";

/** แพ็กเกจบนเว็บ → แพ็กเกจในตารางแล็บ */
export const WEBSITE_PACKAGES: Record<string, string> = {
  "health-checkup-basic": "CHK_S",
  "health-checkup-female": "CHK_F",
  "health-checkup-male": "CHK_M",
};

export const UNAVAILABLE_TITLE = "บริการที่ยังไม่มี";
/** ขึ้นต้นบรรทัดที่ซิงก์เพิ่มเอง แยกจากข้อความที่ admin เขียน */
export const HIDDEN_LINE_PREFIX = "ปิดบนเว็บแล้ว: ";

const baht = (n: number) => n.toLocaleString("en-US");

export function programToKnowledge(p: WebsiteProgram): { category: string; title: string; content: string } {
  const lines: string[] = [];
  if (p.price == null) {
    lines.push(`${NO_PRICE_MARK} ${p.price_note?.trim() || "เจ้าหน้าที่จะแจ้งราคาให้"}`);
  } else {
    lines.push(`ราคา ${baht(p.price)} บาท${p.price_unit ? ` ${p.price_unit}` : ""}`);
    if (p.options.length) {
      lines.push(`ตัวเลือก: ${p.options.map((o) => `${o.label}${o.price == null ? "" : ` ${baht(o.price)} บาท`}${o.note ? ` (${o.note})` : ""}`).join("; ")}`);
    }
    if (p.price_note?.trim()) lines.push(`หมายเหตุ: ${p.price_note.trim()}`);
  }
  if (p.includes.length) lines.push(`รวม: ${p.includes.join(", ")}`);
  return { category: CATEGORY_TH[p.category] ?? FALLBACK_CATEGORY, title: p.name, content: lines.join("\n") };
}

/** แถวที่ผิดรูปแบบทำให้ทั้งรอบล้ม ถ้าข้ามไป บริการนั้นจะถูกปิดเหมือนหายจากเว็บ */
export function parsePrograms(value: unknown): WebsiteProgram[] {
  if (!Array.isArray(value)) throw new Error("ข้อมูลจากเว็บผิดรูปแบบ");
  return value.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const price = r.price == null ? null : Number(r.price);
    if (typeof r.slug !== "string" || !r.slug || typeof r.name !== "string" || !r.name.trim() || (price != null && !Number.isFinite(price))) {
      throw new Error("ข้อมูลบริการจากเว็บไม่ครบ");
    }
    return {
      slug: r.slug,
      category: typeof r.category === "string" ? r.category : "",
      name: r.name.trim(),
      price,
      price_unit: typeof r.price_unit === "string" ? r.price_unit : null,
      price_note: typeof r.price_note === "string" ? r.price_note : null,
      options: Array.isArray(r.options) ? (r.options as WebsiteOption[]).filter((o) => typeof o?.label === "string") : [],
      includes: Array.isArray(r.includes) ? r.includes.filter((i): i is string => typeof i === "string") : [],
      updated_at: typeof r.updated_at === "string" ? r.updated_at : new Date().toISOString(),
    };
  });
}

export async function fetchWebsitePrograms(): Promise<WebsiteProgram[]> {
  const url = process.env.WEBSITE_SUPABASE_URL;
  const key = process.env.WEBSITE_SUPABASE_KEY;
  if (!url || !key) throw new Error("ยังไม่ได้ตั้ง WEBSITE_SUPABASE_URL และ WEBSITE_SUPABASE_KEY");
  const res = await fetch(`${url}/rest/v1/hw_programs?is_published=eq.true&select=slug,category,name,price,price_unit,price_note,options,includes,updated_at`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`อ่านข้อมูลจากเว็บไม่สำเร็จ (${res.status})`);
  return parsePrograms(await res.json());
}

/** เก็บข้อความของ admin ไว้ และเขียนเฉพาะบรรทัดที่ซิงก์เพิ่ม */
export function withHiddenServices(content: string, hidden: string[]): string {
  const kept = content.split("\n").filter((l) => !l.startsWith(HIDDEN_LINE_PREFIX));
  return [...kept, ...[...hidden].sort().map((name) => `${HIDDEN_LINE_PREFIX}${name}`)].join("\n");
}

interface KnowledgeRow { id: string; category: string; title: string; content: string; active: boolean; website_slug: string }

/** ไม่ใช้ราคาจากเว็บเขียนทับต้นทุน แก้เฉพาะคอลัมน์ price */
async function syncPackagePrices(programs: WebsiteProgram[], nowIso: string): Promise<PriceAlert[]> {
  const db = supabaseAdmin();
  const { data } = await db.from("lab_packages").select("code, name, price").in("code", Object.values(WEBSITE_PACKAGES));
  const alerts: PriceAlert[] = [];
  for (const [slug, code] of Object.entries(WEBSITE_PACKAGES)) {
    const pkg = ((data ?? []) as { code: string; name: string; price: number }[]).find((p) => p.code === code);
    if (!pkg) continue;
    const web = programs.find((p) => p.slug === slug);
    if (!web || web.price == null) {
      alerts.push({ code, name: pkg.name, message: `ไม่พบราคาบนเว็บ ราคาแล็บยังเป็น ${baht(Number(pkg.price))} บาท`, at: nowIso });
      continue;
    }
    const before = Number(pkg.price);
    if (before === web.price) continue;
    const { error } = await db.from("lab_packages").update({ price: web.price, updated_at: nowIso }).eq("code", code);
    if (error) throw error;
    alerts.push({ code, name: pkg.name, message: `ราคาไม่ตรงกับเว็บ เปลี่ยนจาก ${baht(before)} เป็น ${baht(web.price)} บาทตามเว็บ`, at: nowIso });
  }
  return alerts;
}

export async function loadSyncStatus(): Promise<WebsiteSyncStatus> {
  return { ...EMPTY_SYNC_STATUS, ...(await getSetting<Partial<WebsiteSyncStatus>>(WEBSITE_SYNC_KEY, {})) };
}

async function saveSyncStatus(status: WebsiteSyncStatus) {
  const { error } = await supabaseAdmin().from("settings").upsert({ key: WEBSITE_SYNC_KEY, value: status }, { onConflict: "key" });
  if (error) console.error("website sync status failed", error.code);
}

async function applyPrograms(programs: WebsiteProgram[], force: boolean, nowIso: string) {
  const db = supabaseAdmin();
  const { data } = await db.from("knowledge_items").select("id, category, title, content, active, website_slug").eq("source", "website");
  const existing = (data ?? []) as KnowledgeRow[];
  const bySlug = new Map(existing.map((k) => [k.website_slug, k]));
  const slugs = new Set(programs.map((p) => p.slug));
  const toHide = existing.filter((k) => k.active && !slugs.has(k.website_slug));

  // API คืนแถวน้อยผิดปกติ เช่น RLS ฝั่งเว็บเปลี่ยน ต้องไม่ปิดบริการทั้งคลินิก
  const activeCount = existing.filter((k) => k.active).length;
  if (!force && activeCount >= 4 && toHide.length > activeCount / 2) {
    return { needsConfirm: true, hideCount: toHide.length };
  }

  const changed = programs
    .map((p) => ({ p, next: programToKnowledge(p), prev: bySlug.get(p.slug) }))
    .filter(({ next, prev }) => !prev || prev.category !== next.category || prev.title !== next.title || prev.content !== next.content);
  // ฝังเฉพาะแถวที่เปลี่ยน รอบปกติจึงไม่เรียก OpenAI
  const embeddings = changed.length ? await embedMany(changed.map(({ next }) => `${next.category} | ${next.title}\n${next.content}`)) : [];
  for (const [i, { p, next, prev }] of changed.entries()) {
    const row = { ...next, active: true, updated_at: p.updated_at, embedding: JSON.stringify(embeddings[i]) };
    const { error } = prev
      ? await db.from("knowledge_items").update(row).eq("id", prev.id)
      : await db.from("knowledge_items").insert({ ...row, source: "website", website_slug: p.slug });
    if (error) throw error;
  }
  // กลับมาแสดงบนเว็บโดยเนื้อหาเท่าเดิม
  const changedSlugs = new Set(changed.map(({ p }) => p.slug));
  for (const prev of existing) {
    if (prev.active || !slugs.has(prev.website_slug) || changedSlugs.has(prev.website_slug)) continue;
    const { error } = await db.from("knowledge_items").update({ active: true }).eq("id", prev.id);
    if (error) throw error;
  }
  for (const k of toHide) {
    const { error } = await db.from("knowledge_items").update({ active: false }).eq("id", k.id);
    if (error) throw error;
  }

  const hiddenNames = existing.filter((k) => !slugs.has(k.website_slug)).map((k) => k.title);
  const { data: unavailable } = await db.from("knowledge_items").select("id, category, title, content").eq("title", UNAVAILABLE_TITLE).eq("source", "manual").maybeSingle();
  if (unavailable) {
    const content = withHiddenServices(unavailable.content as string, hiddenNames);
    if (content !== unavailable.content) {
      const [embedding] = await embedMany([`${unavailable.category} | ${unavailable.title}\n${content}`]);
      const { error } = await db.from("knowledge_items").update({ content, updated_at: nowIso, embedding: JSON.stringify(embedding) }).eq("id", unavailable.id);
      if (error) throw error;
    }
  } else if (hiddenNames.length) {
    const content = withHiddenServices("", hiddenNames).trim();
    const [embedding] = await embedMany([`บริการ | ${UNAVAILABLE_TITLE}\n${content}`]);
    const { error } = await db.from("knowledge_items").insert({ category: "บริการ", title: UNAVAILABLE_TITLE, content, embedding: JSON.stringify(embedding) });
    if (error) throw error;
  }
  return { needsConfirm: false, hideCount: toHide.length, changed: changed.length };
}

export interface SyncResult { ok: boolean; count: number; changed: number; hidden: number; error: string | null; needs_confirm: boolean }

/** ล้มเหลวเมื่อไหร่ก็เก็บข้อมูลเดิมไว้ ราคาเก่าปลอดภัยกว่าไม่มีราคา */
export async function runWebsiteSync({ force = false, now = Date.now() } = {}): Promise<SyncResult> {
  const nowIso = new Date(now).toISOString();
  const status = await loadSyncStatus();
  const fail = async (error: string, needs_confirm = false): Promise<SyncResult> => {
    await saveSyncStatus({ ...status, last_attempt_at: nowIso, error, needs_confirm });
    return { ok: false, count: status.count, changed: 0, hidden: 0, error, needs_confirm };
  };
  try {
    const programs = await fetchWebsitePrograms();
    if (!programs.length) return await fail("เว็บไม่คืนข้อมูลบริการเลย จึงไม่เปลี่ยนข้อมูลเดิม");
    const applied = await applyPrograms(programs, force, nowIso);
    if (applied.needsConfirm) return await fail(`บริการหายจากเว็บ ${applied.hideCount} รายการ มากผิดปกติ จึงยังไม่ปิด`, true);
    const newAlerts = await syncPackagePrices(programs, nowIso);
    // แจ้งเตือนซ้ำรายการเดิมไม่ได้ช่วยอะไร เก็บอันล่าสุดต่อแพ็กเกจและข้อความ
    const fresh = newAlerts.filter((a) => !status.alerts.some((o) => o.code === a.code && o.message === a.message));
    await saveSyncStatus({
      last_attempt_at: nowIso, last_success_at: nowIso, error: null, needs_confirm: false, count: programs.length,
      alerts: [...fresh, ...status.alerts].slice(0, MAX_ALERTS),
    });
    return { ok: true, count: programs.length, changed: applied.changed ?? 0, hidden: applied.hideCount, error: null, needs_confirm: false };
  } catch (e) {
    console.error("website sync failed", e);
    return await fail(e instanceof Error ? e.message : "ซิงก์ไม่สำเร็จ");
  }
}

/** เรียกจาก cron ทุกนาที ซิงก์จริงชั่วโมงละครั้ง นับจากครั้งที่ลองล่าสุด จึงไม่ยิงเว็บทุกนาทีตอนเว็บล่ม */
export async function syncWebsiteIfDue(now = Date.now()): Promise<boolean> {
  const { last_attempt_at } = await loadSyncStatus();
  if (last_attempt_at && now - Date.parse(last_attempt_at) < SYNC_EVERY_MS) return false;
  await runWebsiteSync({ now });
  return true;
}

export async function clearPriceAlerts() {
  await saveSyncStatus({ ...(await loadSyncStatus()), alerts: [] });
}
