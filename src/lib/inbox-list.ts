// รายการแชทแบบคิวงาน ฝั่ง server: ดึงครั้งเดียวต่อหน้า (ทีละ 50 แถว) แทน query หลายตัวจากเบราว์เซอร์
// - มี migration 063: ใช้คอลัมน์ queue / work_label / sort_key ที่ trigger คำนวณไว้ (query ตรง ใช้ index)
// - ยังไม่มี: คำนวณแบบเดิม (inboxWork + inboxSections) ที่ server แล้วแบ่งหน้าเหมือนกัน
import type { SupabaseClient } from "@supabase/supabase-js";
import { inboxSections, topWork, workLabel, type InboxFilter, type InboxSection, type WorkMap } from "./case-flow";
import { inboxWork } from "./inbox-work";
import type { Conversation } from "./types";

export const INBOX_PAGE = 50;
export const INBOX_MAX_PAGE = 200;
export const CONV_COLUMNS = "*, contacts(display_name, avatar_url, language, platform_name, hn, patient_full_name, name_source, patient_relation, name_locked), channels(type, name, ai_mode)";
const SECTIONS: InboxSection[] = ["waiting", "work", "recent"];

export type QueueRow = Conversation & { queue?: InboxSection; work_kind?: string | null; work_label?: string | null; work_since?: string | null; assigned_to?: string | null };
export interface InboxCounts { waiting: number; work: number }
export interface InboxListResult {
  rows: QueueRow[];
  /** หน้าถัดไป (null = หมดแล้ว) */
  next: string | null;
  /** ตัวเลขบนปุ่มกรอง (ตามแท็ก/คำค้นที่กรองอยู่) */
  counts: InboxCounts;
  /** ตัวเลข badge เมนูแชท (ทั้งหมด ไม่ขึ้นกับตัวกรอง) */
  badge: { waiting: number; work: number; total: number };
  mode: "queue" | "compute";
}
export interface InboxListQuery { filter: InboxFilter; q: string; tags: string[]; cursor: string | null; limit: number; meId: string; id?: string | null }

/** cursor = "<ช่วง>:<offset>" */
export function parseCursor(c: string | null | undefined): { sec: InboxSection; offset: number } {
  const [s, o] = String(c ?? "").split(":");
  const sec = (SECTIONS as string[]).includes(s) ? (s as InboxSection) : "waiting";
  return { sec, offset: Math.max(0, Number.parseInt(o, 10) || 0) };
}
export const sectionsFor = (f: InboxFilter): InboxSection[] => (f === "waiting" ? ["waiting"] : f === "work" ? ["work"] : SECTIONS);

let queueColumns: boolean | null = null;
/** มีคอลัมน์ของ migration 063 หรือยัง (ถามครั้งเดียวต่อ instance; ไม่มี → ถามใหม่ทุก 5 นาที) */
let checkedAt = 0;
async function hasQueueColumns(db: SupabaseClient): Promise<boolean> {
  if (queueColumns === true) return true;
  if (queueColumns === false && Date.now() - checkedAt < 5 * 60_000) return false;
  const { error } = await db.from("conversations").select("queue, work_label").limit(1);
  queueColumns = !error;
  checkedAt = Date.now();
  return queueColumns;
}
/** เทส: ล้างค่าที่จำไว้ หรือบังคับโหมด (true = มีคอลัมน์ 063) */
export function resetInboxListCache(force: boolean | null = null) { queueColumns = force; checkedAt = Date.now(); }

async function searchIds(db: SupabaseClient, q: string): Promise<string[] | null> {
  const term = q.trim();
  if (!term) return null;
  const { data } = await db.rpc("search_conversations", { p_query: term });
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

/**
 * db = client ของผู้ใช้ (RLS: คนไม่มีสิทธิ์ไม่เห็นแชทลับ เหมือนตอนเบราว์เซอร์ query เอง)
 * admin = service role (ใช้คำนวณงานค้างแบบเดิม / ตัวเลข badge)
 */
export async function inboxList(db: SupabaseClient, admin: SupabaseClient, p: InboxListQuery, time: <T>(label: string, w: Promise<T>) => Promise<T> = (_l, w) => w): Promise<InboxListResult> {
  const matched = await time("search", searchIds(db, p.q));
  return (await time("probe", hasQueueColumns(admin)))
    ? queueList(db, admin, p, matched, time)
    : computeList(db, admin, p, matched, time);
}

// ---------------------------------------------------------------------------
// โหมด queue (migration 063)
// ---------------------------------------------------------------------------
async function queueList(db: SupabaseClient, admin: SupabaseClient, p: InboxListQuery, matched: string[] | null, time: <T>(label: string, w: Promise<T>) => Promise<T>): Promise<InboxListResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filtered = (query: any) => {
    let q = query;
    if (matched) q = q.in("id", matched.length ? matched : ["00000000-0000-0000-0000-000000000000"]);
    if (p.tags.length) q = q.contains("tags", p.tags);
    return q;
  };
  // ตัวเลขปุ่มกรอง + badge: query เดียวต่อชุด (แถวรอตอบ/งานค้างมีไม่มาก ใช้ partial index)
  const countRows = async (withFilters: boolean) => {
    let q = (withFilters ? db : admin).from("conversations").select("queue").in("queue", ["waiting", "work"]).eq("archived", false);
    if (withFilters) q = filtered(q);
    const { data } = await q.limit(5000);
    const rows = (data ?? []) as { queue: string }[];
    return { waiting: rows.filter((r) => r.queue === "waiting").length, work: rows.filter((r) => r.queue === "work").length };
  };
  const plain = !matched && !p.tags.length;

  if (p.id) {
    const { data } = await time("row", db.from("conversations").select(CONV_COLUMNS).eq("id", p.id).maybeSingle() as unknown as Promise<{ data: QueueRow | null }>);
    const counts = await time("counts", countRows(!plain));
    const badge = plain ? counts : await time("badge", countRows(false));
    return { rows: data ? [data] : [], next: null, counts, badge: { ...badge, total: badge.waiting + badge.work }, mode: "queue" };
  }

  const secs = sectionsFor(p.filter);
  let { sec, offset } = parseCursor(p.cursor);
  if (!secs.includes(sec)) { sec = secs[0]; offset = 0; }
  const rows: QueueRow[] = [];
  let next: string | null = null;
  const pageRows = async () => {
    for (let i = secs.indexOf(sec); i < secs.length; i++) {
      const s = secs[i];
      const start = s === sec ? offset : 0;
      const need = p.limit - rows.length;
      let q = db.from("conversations").select(CONV_COLUMNS).eq("queue", s);
      // แชทเก่า (archived) ปิดอยู่เสมอ อยู่ในช่วงล่าสุดเท่านั้น
      q = s === "recent" ? q.or("status.eq.closed,archived.eq.false") : q.eq("archived", false);
      if (p.filter === "mine") q = q.eq("assigned_to", p.meId);
      q = filtered(q);
      const { data } = await q.order("sort_key", { ascending: s !== "recent", nullsFirst: false }).order("id").range(start, start + need);
      const got = (data ?? []) as unknown as QueueRow[];
      // ขอเกิน 1 แถวเพื่อรู้ว่ายังมีอีกไหม
      rows.push(...got.slice(0, need));
      if (got.length > need) { next = `${s}:${start + need}`; return; }
      if (rows.length >= p.limit) {
        next = i + 1 < secs.length ? `${secs[i + 1]}:0` : null;
        return;
      }
    }
  };
  const [, counts, badge] = await Promise.all([
    time("rows", pageRows()),
    time("counts", countRows(!plain)),
    plain ? Promise.resolve(null) : time("badge", countRows(false)),
  ]);
  const b = badge ?? counts;
  return { rows, next, counts, badge: { ...b, total: b.waiting + b.work }, mode: "queue" };
}

// ---------------------------------------------------------------------------
// โหมด compute (ยังไม่ได้รัน migration 063): กติกาเดิมทั้งหมด แต่ทำที่ server ใน request เดียว
// ---------------------------------------------------------------------------
async function computeList(db: SupabaseClient, admin: SupabaseClient, p: InboxListQuery, matched: string[] | null, time: <T>(label: string, w: Promise<T>) => Promise<T>): Promise<InboxListResult> {
  const base = (status: "open" | "closed") => {
    let q = db.from("conversations").select(CONV_COLUMNS).eq("status", status);
    if (status === "open") q = q.eq("archived", false);
    if (matched) q = q.in("id", matched.length ? matched : ["00000000-0000-0000-0000-000000000000"]);
    return p.tags.length ? q.contains("tags", p.tags) : q;
  };
  const [waiting, open_, closed, work] = await Promise.all([
    time("waiting", base("open").eq("last_direction", "in").order("waiting_since", { ascending: true, nullsFirst: false }).limit(200) as unknown as Promise<{ data: QueueRow[] | null }>),
    time("open", base("open").order("last_message_at", { ascending: false }).limit(200) as unknown as Promise<{ data: QueueRow[] | null }>),
    time("closed", base("closed").order("last_message_at", { ascending: false, nullsFirst: false }).limit(200) as unknown as Promise<{ data: QueueRow[] | null }>),
    time("work", inboxWork()),
  ]);
  let all = [...(waiting.data ?? []), ...(open_.data ?? []), ...(closed.data ?? [])];
  const have = new Set(all.map((c) => c.id));
  const missing = Object.keys(work).filter((id) => !have.has(id) && (!matched || matched.includes(id))).slice(0, 200);
  if (missing.length) {
    let q = db.from("conversations").select(CONV_COLUMNS).in("id", missing);
    if (p.tags.length) q = q.contains("tags", p.tags);
    all = [...all, ...(((await time("extra", q as unknown as Promise<{ data: QueueRow[] | null }>)).data ?? []))];
  }
  const annotate = (c: QueueRow, sec: InboxSection): QueueRow => {
    const top = sec === "work" ? topWork(work[c.id]) : null;
    return { ...c, queue: sec, work_kind: top?.kind ?? null, work_label: top ? workLabel(top) : null, work_since: top ? workSinceOf(work, c.id) : null };
  };
  const totals = inboxSections(all, work);
  const sections = inboxSections(all, work, { filter: p.filter, meId: p.meId });
  const counts = { waiting: totals.waiting.length, work: totals.work.length };
  const badge = await time("badge", badgeCounts(admin, work));

  if (p.id) {
    const row = all.find((c) => c.id === p.id)
      ?? ((await db.from("conversations").select(CONV_COLUMNS).eq("id", p.id).maybeSingle()).data as QueueRow | null);
    if (!row) return { rows: [], next: null, counts, badge, mode: "compute" };
    const sec = (["waiting", "work", "recent"] as InboxSection[]).find((s) => totals[s].some((c) => c.id === row.id))
      ?? (row.status === "open" && row.last_direction === "in" ? "waiting" : work[row.id]?.length ? "work" : "recent");
    return { rows: [annotate(row, sec)], next: null, counts, badge, mode: "compute" };
  }

  const secs = sectionsFor(p.filter);
  let { sec, offset } = parseCursor(p.cursor);
  if (!secs.includes(sec)) { sec = secs[0]; offset = 0; }
  const rows: QueueRow[] = [];
  let next: string | null = null;
  for (let i = secs.indexOf(sec); i < secs.length && !next; i++) {
    const s = secs[i];
    const start = s === sec ? offset : 0;
    const need = p.limit - rows.length;
    const list = sections[s];
    rows.push(...list.slice(start, start + need).map((c) => annotate(c, s)));
    if (list.length > start + need) next = `${s}:${start + need}`;
    else if (rows.length >= p.limit && i + 1 < secs.length) next = `${secs[i + 1]}:0`;
  }
  return { rows, next, counts, badge, mode: "compute" };
}

const workSinceOf = (work: WorkMap, id: string) => {
  const t = (work[id] ?? []).map((i) => i.since).sort()[0];
  return t ?? null;
};

/** badge (โหมด compute): รอตอบทั้งหมด + แชทที่มีงานค้างแต่ไม่ได้รอตอบ */
async function badgeCounts(admin: SupabaseClient, work: WorkMap) {
  const { data } = await admin.from("conversations").select("id").eq("status", "open").eq("last_direction", "in").eq("archived", false).limit(5000);
  const waiting = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
  const w = Object.keys(work).filter((id) => !waiting.has(id)).length;
  return { waiting: waiting.size, work: w, total: waiting.size + w };
}

/** badge เมนูแชท: มี migration 063 = query เดียวจากคอลัมน์ queue */
export async function queueBadge(admin: SupabaseClient): Promise<{ waiting: number; work: number; total: number } | null> {
  if (!(await hasQueueColumns(admin))) return null;
  const { data, error } = await admin.from("conversations").select("queue").in("queue", ["waiting", "work"]).eq("archived", false).limit(5000);
  if (error) return null;
  const rows = (data ?? []) as { queue: string }[];
  const waiting = rows.filter((r) => r.queue === "waiting").length;
  const work = rows.length - waiting;
  return { waiting, work, total: rows.length };
}
