import { embedMany } from "./ai";
import { supabaseAdmin } from "./supabase/admin";

/**
 * เนื้อหาหน้าเว็บคลินิกให้ AI ใช้: ส่วนต่างๆ ของหน้าแรก และบทความทุกบทความ
 * ดึงจาก HTML ของเว็บจริง (เว็บส่งเนื้อหามากับ HTML แล้ว) ราคาบริการไม่อยู่ที่นี่ ซิงก์จาก hw_programs แยกไว้
 */
export const PAGE_SOURCE = "website_page";
export const HOME_CATEGORY = "หน้าเว็บไซต์";
export const ARTICLE_CATEGORY = "บทความเว็บไซต์";
/** ส่วนที่ซ้ำกับข้อมูลอื่น: ราคา (ซิงก์จาก hw_programs) และรายการข่าว (ดึงตัวบทความแทน) */
const SKIP_SECTIONS = new Set(["prices", "news"]);
const CHUNK_CHARS = 1500;
const MAX_ARTICLES = 60;
const FETCH_TIMEOUT_MS = 15_000;

export interface PageChunk { slug: string; category: string; title: string; content: string }

const websiteBase = () => (process.env.WEBSITE_PUBLIC_URL || "https://happiwellclinic.com").replace(/\/+$/, "");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** ลบส่วนที่ไม่ใช่เนื้อหา */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|nav|header|footer|form|button)\b[\s\S]*?<\/\1>/gi, " ");
}

/** HTML เป็นข้อความทีละบรรทัด ตัดบรรทัดว่างและบรรทัดซ้ำติดกัน */
export function htmlToText(html: string): string {
  const text = decodeEntities(
    stripNoise(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|dt|dd|figcaption|table|ul|ol)>/gi, "\n")
      .replace(/<(td|th)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t ]+/g, " ").trim();
    if (line && line !== lines.at(-1)) lines.push(line);
  }
  return lines.join("\n");
}

const firstHeading = (html: string) => {
  const m = /<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i.exec(html);
  return m ? htmlToText(m[1]).replace(/\n/g, " ").trim() : "";
};

/** แบ่งเป็นช่วงไม่เกิน max ตามบรรทัด บรรทัดสั้นอยู่ครบในช่วงเดียว บรรทัดที่ยาวเกินถูกตัดต่อจากช่วงก่อนหน้าให้เต็ม */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (let line of text.split("\n")) {
    while (line) {
      const room = cur ? max - cur.length - 1 : max;
      if (line.length <= room) {
        cur = cur ? `${cur}\n${line}` : line;
        line = "";
      } else if (cur && line.length <= max) {
        chunks.push(cur);
        cur = "";
      } else if (room > 0) {
        chunks.push(cur ? `${cur}\n${line.slice(0, room)}` : line.slice(0, room));
        cur = "";
        line = line.slice(room);
      } else {
        chunks.push(cur);
        cur = "";
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** หน้าแรก: แต่ละ <section> ที่มีหัวข้อเป็น 1 หัวข้อ */
export function parseHomepage(html: string): PageChunk[] {
  const out: PageChunk[] = [];
  const re = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = re.exec(stripNoise(html)))) {
    index++;
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? "";
    if (SKIP_SECTIONS.has(id)) continue;
    const title = firstHeading(m[2]);
    const text = htmlToText(m[2]);
    if (!title || text.length < 30) continue;
    const key = id || `section-${index}`;
    chunkText(text).forEach((content, i, all) => out.push({
      slug: `page:home:${key}${all.length > 1 ? `:${i + 1}` : ""}`,
      category: HOME_CATEGORY,
      title: all.length > 1 ? `${title} (${i + 1}/${all.length})` : title,
      content,
    }));
  }
  return out;
}

/** ลิงก์บทความในหน้า เช่น /articles/nhso-quota-cut-2569 */
export function findArticleSlugs(html: string): string[] {
  const slugs = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["'](?:https?:\/\/[^"'/]+)?\/articles\/([a-z0-9][a-z0-9_-]*)\/?["'#?]/gi)) slugs.add(m[1].toLowerCase());
  return [...slugs].slice(0, MAX_ARTICLES);
}

/** บทความ: ใช้ <article> หรือ <main> ตัดลิงก์กลับหน้ารวม */
export function parseArticle(slug: string, html: string): PageChunk[] {
  const body = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html)?.[1]
    ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1]
    ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  const title = firstHeading(body) || firstHeading(html) || slug;
  const text = htmlToText(body).split("\n").filter((l) => !/^←|กลับไปหน้าข่าวสาร/.test(l)).join("\n");
  if (text.length < 50) return [];
  return chunkText(text).map((content, i, all) => ({
    slug: `article:${slug}${all.length > 1 ? `:${i + 1}` : ""}`,
    category: ARTICLE_CATEGORY,
    title: all.length > 1 ? `${title} (${i + 1}/${all.length})` : title,
    content,
  }));
}

async function fetchHtml(path: string): Promise<string> {
  const res = await fetch(`${websiteBase()}${path}`, {
    headers: { "User-Agent": "DocDesk website sync", Accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`เปิดหน้าเว็บ ${path} ไม่สำเร็จ (${res.status})`);
  return res.text();
}

/** ดึงเนื้อหาทั้งเว็บ: หน้าแรก + บทความที่ลิงก์จากหน้าแรกและหน้ารวมบทความ บทความที่เปิดไม่ได้ข้ามไป */
export async function fetchWebsitePages(): Promise<PageChunk[]> {
  const home = await fetchHtml("/");
  const listing = await fetchHtml("/articles").catch(() => "");
  const chunks = parseHomepage(home);
  for (const slug of findArticleSlugs(`${home}\n${listing}`)) {
    try {
      chunks.push(...parseArticle(slug, await fetchHtml(`/articles/${slug}`)));
    } catch (e) {
      console.error("website article fetch failed", slug, e instanceof Error ? e.message : e);
    }
  }
  return chunks;
}

interface PageRow { id: string; category: string; title: string; content: string; active: boolean; website_slug: string }

/**
 * เขียนลง knowledge_items (source = website_page) ฝังเฉพาะที่เปลี่ยน ปิดหัวข้อที่หายจากเว็บ
 * ได้หัวข้อน้อยผิดปกติ (เว็บล่มหรือเปลี่ยนโครงสร้าง) ไม่ปิดของเดิม
 */
export async function applyWebsitePages(chunks: PageChunk[]): Promise<{ count: number; changed: number; hidden: number }> {
  const db = supabaseAdmin();
  const { data } = await db.from("knowledge_items").select("id, category, title, content, active, website_slug").eq("source", PAGE_SOURCE);
  const existing = (data ?? []) as PageRow[];
  const bySlug = new Map(existing.map((k) => [k.website_slug, k]));
  const slugs = new Set(chunks.map((c) => c.slug));

  const changed = chunks.filter((c) => {
    const prev = bySlug.get(c.slug);
    return !prev || !prev.active || prev.category !== c.category || prev.title !== c.title || prev.content !== c.content;
  });
  const embeddings = changed.length ? await embedMany(changed.map((c) => `${c.category} | ${c.title}\n${c.content}`)) : [];
  const nowIso = new Date().toISOString();
  for (const [i, c] of changed.entries()) {
    const prev = bySlug.get(c.slug);
    const row = { category: c.category, title: c.title, content: c.content, active: true, updated_at: nowIso, embedding: JSON.stringify(embeddings[i]) };
    const { error } = prev
      ? await db.from("knowledge_items").update(row).eq("id", prev.id)
      : await db.from("knowledge_items").insert({ ...row, source: PAGE_SOURCE, website_slug: c.slug });
    if (error) throw error;
  }

  const active = existing.filter((k) => k.active);
  const toHide = active.filter((k) => !slugs.has(k.website_slug));
  const tooMany = active.length >= 4 && toHide.length > active.length / 2;
  if (!tooMany) {
    for (const k of toHide) {
      const { error } = await db.from("knowledge_items").update({ active: false }).eq("id", k.id);
      if (error) throw error;
    }
  }
  return { count: chunks.length, changed: changed.length, hidden: tooMany ? 0 : toHide.length };
}

export async function syncWebsitePages() {
  const chunks = await fetchWebsitePages();
  if (!chunks.length) throw new Error("ไม่พบเนื้อหาในหน้าเว็บ จึงไม่เปลี่ยนข้อมูลเดิม");
  return applyWebsitePages(chunks);
}
