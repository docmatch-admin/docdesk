import { tagLabel } from "./sensitive-rules";
import { CHANNEL_LABEL, type ChannelType } from "./types";

export type TagGroup = "topic" | "status" | "customer";

export const TAG_GROUP_LABEL: Record<TagGroup, string> = {
  topic: "เรื่องที่ติดต่อ",
  status: "สถานะ",
  customer: "ประเภทลูกค้า",
};

export interface Tag { id: string; name: string; color: string; group: TagGroup; sort: number; active: boolean }
export interface TagRule { id?: string; kind: "keyword" | "non_thai"; keyword: string; exclude_keywords?: string; tag: string }

export const DEFAULT_TAG_COLOR = "#475569";

/** ต้องใช้ภาษาอื่นอย่างน้อยเท่านี้ข้อความ คนไทยที่พิมพ์ "HPV vaccine price" ครั้งเดียวจะได้ไม่ติดแท็กต่างชาติ */
export const NON_THAI_MIN_MESSAGES = 2;

const ASCII_WORD = /^[a-z0-9 ]+$/;
const ASCII_CHAR = /[a-z0-9]/;

/** คำอังกฤษต้องตรงทั้งคำ ไม่อย่างนั้น "HR" จะตรงกับ "three" ส่วนภาษาไทยไม่มีช่องว่างคั่นคำจึงเทียบแบบมีอยู่ในข้อความ */
function containsKeyword(hay: string, keyword: string): boolean {
  if (!ASCII_WORD.test(keyword)) return hay.includes(keyword);
  for (let at = hay.indexOf(keyword); at !== -1; at = hay.indexOf(keyword, at + 1)) {
    const before = hay[at - 1] ?? "";
    const after = hay[at + keyword.length] ?? "";
    if (!ASCII_CHAR.test(before) && !ASCII_CHAR.test(after)) return true;
  }
  return false;
}

/** คำคั่นด้วย | เป็นข้อความธรรมดา ไม่ตีความเป็น regex กันกฎที่พิมพ์ผิดหรือทำให้ระบบช้า */
function matchesAny(hay: string, list: string | undefined): boolean {
  return (list ?? "").split("|").map((k) => k.trim().toLowerCase()).filter(Boolean).some((k) => containsKeyword(hay, k));
}

/** foreignMessages = จำนวนข้อความของลูกค้าที่ toThai ตรวจว่าไม่ใช่ภาษาไทย รวมข้อความนี้ */
export function matchTagRules(text: string, foreignMessages: number, rules: TagRule[], activeTags: string[]): string[] {
  const hay = text.toLowerCase();
  const active = new Set(activeTags);
  const out = new Set<string>();
  for (const rule of rules) {
    if (!active.has(rule.tag)) continue;
    const hit = rule.kind === "non_thai"
      ? foreignMessages >= NON_THAI_MIN_MESSAGES
      : matchesAny(hay, rule.keyword) && !matchesAny(hay, rule.exclude_keywords);
    if (hit) out.add(rule.tag);
  }
  return [...out];
}

/** รับเฉพาะชื่อแท็กที่มีอยู่จริง AI แต่งชื่อใหม่ไม่ได้ */
export function sanitizeSuggestedTags(raw: unknown, activeTags: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const active = new Set(activeTags);
  return [...new Set(raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => active.has(t)))].slice(0, 3);
}

// ---------------------------------------------------------------------------
// รายงาน
// ---------------------------------------------------------------------------
export type ReportUnit = "day" | "month";
export interface ReportRow { bucket: string; tag: string; chats: number }

export function bangkokDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isValidDate = (s: string | null): s is string => !!s && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** วันเริ่ม-สิ้นสุดตามเวลาไทย → ช่วงเวลาจริง (to ไม่รวม) */
export function bangkokRange(from: string, to: string) {
  const end = new Date(Date.parse(`${to}T00:00:00+07:00`) + 24 * 60 * 60 * 1000);
  return { from: `${from}T00:00:00+07:00`, to: end.toISOString() };
}

/** ทุกช่วงเวลาในรายงาน รวมวันที่ไม่มีข้อมูล กราฟจะได้ไม่ข้ามวันเงียบๆ */
export function buildBuckets(unit: ReportUnit, from: string, to: string): string[] {
  const out: string[] = [];
  if (unit === "day") {
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }
  let [y, m] = from.split("-").map(Number);
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) return out;
    out.push(`${key}-01`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
}

export interface ReportTable {
  buckets: string[];
  rows: { tag: string; counts: number[]; total: number }[];
}

/** ตารางแท็ก × ช่วงเวลา เรียงแท็กที่มีแชทมากสุดก่อน */
export function buildReportTable(data: ReportRow[], buckets: string[]): ReportTable {
  const index = new Map(buckets.map((b, i) => [b, i]));
  const byTag = new Map<string, number[]>();
  for (const r of data) {
    const i = index.get(r.bucket);
    if (i === undefined) continue;
    const counts = byTag.get(r.tag) ?? buckets.map(() => 0);
    counts[i] += Number(r.chats);
    byTag.set(r.tag, counts);
  }
  const rows = [...byTag.entries()]
    .map(([tag, counts]) => ({ tag, counts, total: counts.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total || a.tag.localeCompare(b.tag, "th"));
  return { buckets, rows };
}

/** ค่าบนสุดของแกน Y ที่เป็นเลขกลมๆ */
export function niceMax(max: number): number {
  if (max <= 5) return Math.max(max, 1);
  const pow = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((s) => s * pow >= max) ?? 10;
  return step * pow;
}

// ---------------------------------------------------------------------------
// ส่งออก CSV
// ---------------------------------------------------------------------------
export interface ExportRow { display_name: string | null; channel: string; tag: string; tagged_at: string }

/** ชื่อลูกค้าตั้งเองได้ ชื่อที่ขึ้นต้นด้วย = + - @ จะกลายเป็นสูตรเมื่อเปิดใน Excel */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** มีเฉพาะชื่อที่แสดง ช่องทาง แท็ก และวันที่ ห้ามมีเนื้อหาแชท มี BOM ให้ Excel อ่านภาษาไทยถูก */
export function buildTagCsv(rows: ExportRow[]): string {
  const lines = [["ชื่อที่แสดง", "ช่องทาง", "แท็ก", "วันที่ติดแท็ก"].join(",")];
  for (const r of rows) {
    lines.push([
      r.display_name || "ลูกค้า",
      CHANNEL_LABEL[r.channel as ChannelType] ?? r.channel,
      tagLabel(r.tag),
      bangkokDay(new Date(r.tagged_at)),
    ].map(csvCell).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
