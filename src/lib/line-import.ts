import { maskBookingPii } from "./booking-rules";
import { scrubPII } from "./pii";

/** ไฟล์ jsonl จากสคริปต์เก็บประวัติ ใช้ทั้งหน้าเว็บและ server */
export interface ImportRecord {
  room: string;
  room_id?: string | null;
  sender: "customer" | "official";
  sent_at: string;
  text: string;
  /** text, sticker, image, system ... */
  type?: string;
  /** ข้อความที่ LINE ส่งเอง: broadcast, auto_reply */
  origin?: string | null;
  /** ลำดับในไฟล์ เวลาในไฟล์ละเอียดแค่นาทีและบางแถวไม่มีเวลา */
  seq?: number;
}

export interface ImportMeta {
  source?: string;
  exported_at?: string;
  reference_date?: string;
  rooms?: number;
  messages?: number;
  list_complete?: boolean;
  errors?: unknown[];
}

export interface ParsedHistory {
  records: ImportRecord[];
  invalid: number;
  meta: ImportMeta | null;
  /** id ซ้ำในไฟล์ */
  duplicates: number;
  /** แถวที่ไม่มีเวลา ใช้เวลาของข้อความก่อนหน้าแทน */
  estimatedTimes: number;
}

export interface ImportRoom { key: string; room: string; messages: ImportRecord[]; chatId?: string | null }

const MIN_ANSWER_CHARS = 4;
const MIN_QUESTION_CHARS = 3;
const MAX_REPLY_GAP_MS = 24 * 3_600_000;
const SAME_ANSWER_GAP_MS = 5 * 60_000;
const BROADCAST_WINDOW_MS = 10 * 60_000;
const BROADCAST_ROOMS = 3;
const TEMPLATE_ROOMS = 5;
const TEMPLATE_MIN_CHARS = 20;

const isText = (m: ImportRecord) => (m.type ?? "text") === "text" && !!m.text.trim();
const time = (m: ImportRecord) => Date.parse(m.sent_at);

export function isValidRecord(r: unknown): r is ImportRecord {
  const m = r as Partial<ImportRecord> | null;
  return !!m && typeof m.room === "string" && !!m.room.trim()
    && (m.sender === "customer" || m.sender === "official")
    && typeof m.sent_at === "string" && !Number.isNaN(Date.parse(m.sent_at))
    && typeof m.text === "string";
}

const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** วันที่ในไฟล์ไม่มีปี เช่น "27 ต.ค. (อ.)" เดือนที่ยังไม่ถึงคือของปีก่อน */
export function parseThaiDate(value: string, reference: string): string | null {
  const shift = (days: number) => new Date(Date.parse(`${reference}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const text = value.trim();
  if (text.startsWith("วันนี้")) return reference;
  if (text.startsWith("เมื่อวาน")) return shift(-1);
  const m = text.match(/^(\d{1,2})\s*([^\s(]+)/);
  const month = m ? THAI_MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return null;
  const build = (year: number) => `${year}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const year = Number(reference.slice(0, 4));
  const date = build(year) > reference ? build(year - 1) : build(year);
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
}

/** "14.05 น." เป็น "14:05" */
export function parseThaiTime(value: unknown): string | null {
  const m = typeof value === "string" ? value.match(/(\d{1,2})[.:](\d{2})/) : null;
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

interface FileMessage { date?: unknown; time?: unknown; role?: unknown; text?: unknown; type?: unknown; id?: unknown }

/** แถวละห้อง: แปลงเป็นข้อความทีละแถว บวกวินาทีตามลำดับ เพราะเวลาในไฟล์ละเอียดแค่นาที */
function expandRoom(row: { display_name?: unknown; line_user_id: string; messages: FileMessage[] }, reference: string, out: ParsedHistory) {
  const name = typeof row.display_name === "string" ? row.display_name.trim() : "";
  const room = name || `ลูกค้าไม่มีชื่อ ${row.line_user_id.slice(-6)}`;
  const seenIds = new Set<string>();
  const inMinute = new Map<string, number>();
  let lastTime: { date: string; time: string } | null = null;
  row.messages.forEach((m, seq) => {
    const date = typeof m.date === "string" ? parseThaiDate(m.date, reference) : null;
    if (!date || !["customer", "clinic", "auto", "system"].includes(String(m.role)) || typeof m.text !== "string") {
      out.invalid++;
      return;
    }
    if (typeof m.id === "string") {
      if (seenIds.has(m.id)) {
        out.duplicates++;
        return;
      }
      seenIds.add(m.id);
    }
    let time = parseThaiTime(m.time);
    if (!time) {
      time = lastTime?.date === date ? lastTime.time : "00:00";
      if (m.role !== "system") out.estimatedTimes++;
    }
    lastTime = { date, time };
    const minute = `${date}T${time}`;
    const second = Math.min(inMinute.get(minute) ?? 0, 59);
    inMinute.set(minute, second + 1);
    out.records.push({
      room,
      room_id: row.line_user_id,
      sender: m.role === "customer" ? "customer" : "official",
      sent_at: new Date(`${minute}:${String(second).padStart(2, "0")}+07:00`).toISOString(),
      text: m.text,
      type: m.role === "system" ? "system" : typeof m.type === "string" ? m.type : "text",
      origin: m.role === "auto" ? "auto_reply" : null,
      seq,
    });
  });
}

/** รับทั้งแถวละข้อความ และแถวละห้องที่มี _meta */
export function parseLineHistory(content: string): ParsedHistory {
  const out: ParsedHistory = { records: [], invalid: 0, meta: null, duplicates: 0, estimatedTimes: 0 };
  const rows: unknown[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { _meta?: ImportMeta };
      if (parsed?._meta) out.meta = parsed._meta;
      else rows.push(parsed);
    } catch {
      out.invalid++;
    }
  }
  const reference = out.meta?.reference_date && /^\d{4}-\d{2}-\d{2}$/.test(out.meta.reference_date)
    ? out.meta.reference_date
    : new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    const r = row as { line_user_id?: unknown; messages?: unknown; display_name?: unknown };
    if (typeof r?.line_user_id === "string" && Array.isArray(r.messages)) {
      expandRoom(r as { display_name?: unknown; line_user_id: string; messages: FileMessage[] }, reference, out);
    } else if (isValidRecord(row)) out.records.push(row);
    else out.invalid++;
  }
  return out;
}

/** room_id แยกลูกค้าชื่อซ้ำกันได้ ข้อความระบบไม่นำเข้า */
export function groupRooms(records: ImportRecord[]): ImportRoom[] {
  const rooms = new Map<string, ImportRoom>();
  for (const m of records) {
    if (m.type === "system") continue;
    const key = m.room_id || m.room;
    const room = rooms.get(key) ?? { key, room: m.room.trim(), messages: [], chatId: m.room_id ?? null };
    room.messages.push(m);
    rooms.set(key, room);
  }
  // ลำดับในไฟล์เชื่อถือได้กว่าเวลา ซึ่งบางแถวเป็นค่าประมาณ
  for (const room of rooms.values()) room.messages.sort((a, b) => (a.seq != null && b.seq != null ? a.seq - b.seq : time(a) - time(b)));
  return [...rooms.values()];
}

/** ชื่อที่มีมากกว่าหนึ่งห้อง ห้ามเดาว่าเป็นใคร */
export function ambiguousNames(rooms: ImportRoom[]): Set<string> {
  const seen = new Map<string, number>();
  for (const r of rooms) seen.set(r.room, (seen.get(r.room) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
}

/**
 * ข้อความเดียวกันหลายห้องคือบรอดแคสต์หรือข้อความอัตโนมัติ เผื่อข้อมูลไม่ได้ระบุ origin
 * ส่งพร้อมกัน 3 ห้องขึ้นไป หรือข้อความยาวเหมือนกัน 5 ห้องขึ้นไปแม้คนละเวลา เช่น ข้อความทักทาย
 */
export function findMassMessages(rooms: ImportRoom[]): Set<string> {
  const byText = new Map<string, { key: string; at: number }[]>();
  for (const room of rooms) {
    for (const m of room.messages) {
      if (m.sender !== "official" || !isText(m)) continue;
      const text = m.text.trim();
      byText.set(text, [...(byText.get(text) ?? []), { key: room.key, at: time(m) }]);
    }
  }
  const mass = new Set<string>();
  for (const [text, hits] of byText) {
    if (text.length >= TEMPLATE_MIN_CHARS && new Set(hits.map((h) => h.key)).size >= TEMPLATE_ROOMS) {
      mass.add(text);
      continue;
    }
    const sorted = [...hits].sort((a, b) => a.at - b.at);
    for (const first of sorted) {
      const near = new Set(sorted.filter((h) => h.at >= first.at && h.at - first.at <= BROADCAST_WINDOW_MS).map((h) => h.key));
      if (near.size >= BROADCAST_ROOMS) {
        mass.add(text);
        break;
      }
    }
  }
  return mass;
}

export interface ExamplePair { question: string; answer: string; answeredAt: string; first: ImportRecord }

/** คู่ข้อความลูกค้ากับคำตอบพนักงาน ตัดข้อมูลส่วนตัวรวมถึงชื่อห้องแล้ว */
export function buildExamplePairs(room: ImportRoom, mass: Set<string>): ExamplePair[] {
  const clean = (text: string) => scrubPII(maskBookingPii(text, [{ name: room.room }])).trim();
  const pairs: ExamplePair[] = [];
  let questions: ImportRecord[] = [];
  let answers: ImportRecord[] = [];

  const flush = () => {
    if (questions.length && answers.length) {
      const question = clean(questions.map((m) => m.text.trim()).join("\n"));
      const answer = clean(answers.map((m) => m.text.trim()).join("\n"));
      if (question.length >= MIN_QUESTION_CHARS && answer.length >= MIN_ANSWER_CHARS) {
        pairs.push({ question, answer, answeredAt: answers[0].sent_at, first: answers[0] });
      }
    }
    questions = [];
    answers = [];
  };

  for (const m of room.messages) {
    if (m.sender === "customer") {
      if (answers.length) flush();
      if (isText(m)) questions.push(m);
      continue;
    }
    // ข้อความอัตโนมัติคั่นกลางไม่นับเป็นคำตอบ และไม่ทำให้คำถามหาย
    if (!isText(m) || m.origin || mass.has(m.text.trim())) continue;
    if (answers.length) {
      if (time(m) - time(answers.at(-1) as ImportRecord) <= SAME_ANSWER_GAP_MS) answers.push(m);
      continue;
    }
    if (!questions.length) continue;
    if (time(m) - time(questions.at(-1) as ImportRecord) > MAX_REPLY_GAP_MS) {
      questions = [];
      continue;
    }
    answers.push(m);
  }
  flush();
  return pairs;
}

export interface ImportSummary { rooms: number; messages: number; from: string | null; to: string | null; pairs: number }

export function summarizeImport(rooms: ImportRoom[]): ImportSummary {
  const mass = findMassMessages(rooms);
  const times = rooms.flatMap((r) => r.messages.map(time));
  return {
    rooms: rooms.length,
    messages: times.length,
    from: times.length ? new Date(Math.min(...times)).toISOString() : null,
    to: times.length ? new Date(Math.max(...times)).toISOString() : null,
    pairs: rooms.reduce((n, r) => n + buildExamplePairs(r, mass).length, 0),
  };
}

export const PLACEHOLDER: Record<string, string> = { sticker: "[สติกเกอร์]", image: "[รูปภาพ]", video: "[วิดีโอ]", file: "[ไฟล์]", audio: "[เสียง]" };
/** เนื้อหาที่แสดงในประวัติแชท */
export const historyBody = (m: ImportRecord) => (isText(m) ? m.text : PLACEHOLDER[m.type ?? ""] ?? "[ไฟล์แนบ]");
