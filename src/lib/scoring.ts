import { businessSeconds, type BusinessHoursConfig } from "./business-hours";
import { classifyAck } from "./suggest-rules";

export interface ScoreRules {
  speed: { maxSeconds: number; points: number }[];
  shortChars: number;
  starPoints: number;
  closePoints: number;
}

export const DEFAULT_SCORE_RULES: ScoreRules = {
  speed: [{ maxSeconds: 120, points: 3 }, { maxSeconds: 300, points: 2 }, { maxSeconds: 900, points: 1 }],
  shortChars: 15,
  starPoints: 2,
  closePoints: 1,
};

/** ค่าที่เสียใช้ค่าเริ่มต้น คะแนนต้องไม่ติดลบ */
export function normalizeScoreRules(value: unknown): ScoreRules {
  const v = (value ?? {}) as Partial<ScoreRules>;
  const num = (x: unknown, fallback: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : fallback);
  const speed = Array.isArray(v.speed) && v.speed.length
    ? v.speed
        .filter((s) => Number.isFinite(s?.maxSeconds) && Number.isFinite(s?.points) && s.maxSeconds >= 0 && s.points >= 0)
        .sort((a, b) => a.maxSeconds - b.maxSeconds)
    : [];
  return {
    speed: speed.length ? speed : DEFAULT_SCORE_RULES.speed,
    shortChars: num(v.shortChars, DEFAULT_SCORE_RULES.shortChars),
    starPoints: num(v.starPoints, DEFAULT_SCORE_RULES.starPoints),
    closePoints: num(v.closePoints, DEFAULT_SCORE_RULES.closePoints),
  };
}

export function speedPoints(seconds: number, replyLength: number, rules: ScoreRules): number {
  const base = rules.speed.find((s) => seconds <= s.maxSeconds)?.points ?? 0;
  return replyLength < rules.shortChars ? base / 2 : base;
}

interface ChatMessage { id: string; direction: string; body: string; created_at: string }

const isSticker = (body: string) => /^\s*\[ลูกค้าส่ง\s*(sticker|สติกเกอร์)/i.test(body);
const isCountable = (m: ChatMessage) => !isSticker(m.body) && !classifyAck(m.body);

/**
 * เหตุการณ์ตอบของเจ้าหน้าที่ null = ไม่ได้คะแนนความเร็ว เช่น ตอบต่อจากตัวเองหรือ AI
 * ชุดข้อความ = ข้อความลูกค้าหลังข้อความขาออกล่าสุด และหลังกดเสร็จแล้วครั้งล่าสุด
 * เวลาเริ่มนับจากข้อความแรกที่ต้องตอบจริง คำขอบคุณและสติกเกอร์ไม่นับ
 */
export function buildResponseEvent(input: {
  conversationId: string;
  replyId: string;
  staffId: string;
  replyText: string;
  repliedAt: string;
  messages: ChatMessage[];
  closedAt: string | null;
  hours: BusinessHoursConfig;
  rules: ScoreRules;
}) {
  const earlier = input.messages
    .filter((m) => m.id !== input.replyId)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const batch: ChatMessage[] = [];
  for (let i = earlier.length - 1; i >= 0; i--) {
    if (earlier[i].direction === "out") break;
    if (input.closedAt && Date.parse(earlier[i].created_at) <= Date.parse(input.closedAt)) break;
    batch.unshift(earlier[i]);
  }
  const first = batch.find(isCountable);
  if (!first) return null;

  const reply_length = [...input.replyText.trim()].length;
  const business_seconds = businessSeconds(first.created_at, input.repliedAt, input.hours);
  return {
    conversation_id: input.conversationId,
    inbound_message_id: first.id,
    first_inbound_at: first.created_at,
    replied_by: input.staffId,
    replied_at: input.repliedAt,
    response_seconds: Math.max(0, Math.floor((Date.parse(input.repliedAt) - Date.parse(first.created_at)) / 1000)),
    business_seconds,
    points: speedPoints(business_seconds, reply_length, input.rules),
    reply_length,
  };
}

// ---------------------------------------------------------------------------
// รายงานทีม
// ---------------------------------------------------------------------------
export type TeamPeriod = "day" | "week" | "month";

const FIVE_MINUTES = 300;

/** ช่วงเวลาตามเวลาไทย สัปดาห์เริ่มวันจันทร์ */
export function periodStart(period: TeamPeriod, now = Date.now()): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  if (period === "month") return `${date.slice(0, 7)}-01T00:00:00+07:00`;
  if (period === "week") {
    const noon = Date.parse(`${date}T12:00:00Z`);
    const sinceMonday = (new Date(noon).getUTCDay() + 6) % 7;
    return `${new Date(noon - sinceMonday * 86_400_000).toISOString().slice(0, 10)}T00:00:00+07:00`;
  }
  return `${date}T00:00:00+07:00`;
}

export interface ResponseRow { replied_by: string; conversation_id: string; business_seconds: number; points: number }
export interface ScoreRow { staff_id: string; points: number }
export interface TeamRow {
  staffId: string;
  name: string;
  chats: number;
  medianSeconds: number | null;
  within5Percent: number | null;
  speedPoints: number;
  qualityPoints: number;
  total: number;
  rank: number;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const roundPoints = (n: number) => Math.round(n * 100) / 100;

/** คะแนนเท่ากันได้อันดับเดียวกัน */
export function buildTeamReport(responses: ResponseRow[], scores: ScoreRow[], staff: { id: string; display_name: string; active: boolean }[]): TeamRow[] {
  const rows = staff
    .map((s) => {
      const mine = responses.filter((r) => r.replied_by === s.id);
      const seconds = mine.map((r) => Number(r.business_seconds));
      const speed = roundPoints(mine.reduce((sum, r) => sum + Number(r.points), 0));
      const quality = roundPoints(scores.filter((x) => x.staff_id === s.id).reduce((sum, x) => sum + Number(x.points), 0));
      return {
        staffId: s.id,
        name: s.display_name,
        active: s.active,
        chats: new Set(mine.map((r) => r.conversation_id)).size,
        medianSeconds: median(seconds),
        within5Percent: seconds.length ? Math.round((seconds.filter((x) => x <= FIVE_MINUTES).length / seconds.length) * 100) : null,
        speedPoints: speed,
        qualityPoints: quality,
        total: roundPoints(speed + quality),
        rank: 0,
      };
    })
    // บัญชีที่ปิดแล้วแสดงเฉพาะเมื่อมีผลงานในช่วงนั้น
    .filter((r) => r.active || r.total > 0 || r.chats > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "th"));
  return rows.map(({ active: _active, ...r }) => ({ ...r, rank: rows.findIndex((x) => x.total === r.total) + 1 }));
}
