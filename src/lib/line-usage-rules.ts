/** สรุปการใช้ LINE (ใช้ได้ทั้ง server และหน้าเว็บ) */
export type LineSendKind = "chat" | "appointment" | "reminder" | "broadcast";

export const LINE_KINDS: LineSendKind[] = ["chat", "appointment", "reminder", "broadcast"];
export const LINE_KIND_LABEL: Record<LineSendKind, string> = { chat: "ตอบแชท", appointment: "นัด", reminder: "เตือนนัด", broadcast: "บรอดแคสต์" };

export interface LineUsageSummary {
  month: string;
  /** ข้อความ push ที่ส่งสำเร็จ (LINE นับโควตาต่อข้อความ) แยกตามประเภท */
  push: Record<LineSendKind, number>;
  pushTotal: number;
  /** ข้อความที่ส่งด้วย reply (ฟรี) และจำนวนครั้ง */
  replyMessages: number;
  replyRequests: number;
  /** reply ไม่สำเร็จแล้ว push แทน (token หมดอายุ/ใช้แล้ว) */
  fallbacks: number;
  failed: number;
}

/** แถวสรุปจาก line_send_summary (หรือแถวเดี่ยว requests = 1) */
export type LineSendGroup = { mode: "reply" | "push"; kind: LineSendKind; ok: boolean; fallback: boolean; requests: number; messages: number };

export function summarizeLineSends(rows: LineSendGroup[], month: string): LineUsageSummary {
  const push = Object.fromEntries(LINE_KINDS.map((k) => [k, 0])) as Record<LineSendKind, number>;
  const out: LineUsageSummary = { month, push, pushTotal: 0, replyMessages: 0, replyRequests: 0, fallbacks: 0, failed: 0 };
  for (const r of rows) {
    const requests = Number(r.requests);
    const messages = Number(r.messages);
    if (!r.ok) { if (r.mode === "push") out.failed += requests; continue; }
    if (r.mode === "push") {
      push[r.kind] = (push[r.kind] ?? 0) + messages;
      out.pushTotal += messages;
      if (r.fallback) out.fallbacks += requests;
    } else {
      out.replyMessages += messages;
      out.replyRequests += requests;
    }
  }
  return out;
}

/** วันแรกของเดือนนี้ตามเวลาไทย (LINE รีเซ็ตโควตาต้นเดือน) */
export function bangkokMonthStart(now = Date.now()): { month: string; startIso: string } {
  const ym = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit" }).format(new Date(now));
  return { month: ym, startIso: new Date(`${ym}-01T00:00:00+07:00`).toISOString() };
}

// ---------------------------------------------------------------------------
// โควตาใกล้หมด/หมด
// ---------------------------------------------------------------------------
/** ok, warn = ใช้ ≥ 80% (แถบเหลือง), low = เหลือน้อยกว่า 10% (งด push ข้อความลงนัด/เปลี่ยนนัด), out = หมด (แถบแดง) */
export type QuotaLevel = "ok" | "warn" | "low" | "out";

export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_LOW_RATIO = 0.9;

export function quotaLevel(limit: number | null, used: number, exhausted = false): QuotaLevel {
  if (exhausted) return "out";
  if (limit == null || limit <= 0) return "ok";
  if (used >= limit) return "out";
  const ratio = used / limit;
  if (ratio >= QUOTA_LOW_RATIO) return "low";
  if (ratio >= QUOTA_WARN_RATIO) return "warn";
  return "ok";
}

export interface QuotaState { type: string; limit: number | null; used: number; remaining: number | null; level: QuotaLevel; checkedAt: string | null }

/** ข้อความแถบบนทุกหน้า (ไม่มีแถบเมื่อ ok) */
export function quotaBanner(s: Pick<QuotaState, "level" | "remaining">): { tone: "warn" | "out"; text: string } | null {
  if (s.level === "out") return { tone: "out", text: "โควตา LINE เดือนนี้หมดแล้ว — ข้อความนัด/เตือนที่ส่งไม่ออกเข้ารายการ \"ต้องโทร\" พนักงานตอบได้เฉพาะตอนลูกค้าเพิ่งทักมา" };
  if (s.level === "warn" || s.level === "low") {
    return { tone: "warn", text: `โควตา LINE เหลือ ${(s.remaining ?? 0).toLocaleString("th-TH")} ข้อความ — นัดอาจส่งไม่ได้${s.level === "low" ? " (งดส่งข้อความลงนัด/เปลี่ยนนัดแบบ push เก็บไว้ใช้เตือนก่อนวันนัด)" : ""}` };
  }
  return null;
}

/**
 * คาดการณ์วันที่โควตาหมดจากอัตราการใช้ตั้งแต่ต้นเดือน (เวลาไทย)
 * null = ไม่จำกัด หรือยังไม่ได้ใช้ / beforeMonthEnd=false = ใช้อัตรานี้ไม่หมดก่อนสิ้นเดือน
 */
export function quotaForecast(limit: number | null, used: number, now = Date.now()): { date: string; beforeMonthEnd: boolean } | null {
  if (limit == null || limit <= 0 || used <= 0) return null;
  const { month, startIso } = bangkokMonthStart(now);
  const [y, m] = month.split("-").map(Number);
  const monthEnd = Date.parse(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01T00:00:00+07:00`);
  if (used >= limit) return { date: bangkokDate(now), beforeMonthEnd: true };
  // อย่างน้อย 1 วัน ต้นเดือนใช้นิดเดียวจะได้ไม่คาดการณ์เกินจริง
  const elapsedDays = Math.max(1, (now - Date.parse(startIso)) / 86_400_000);
  const perDay = used / elapsedDays;
  const at = now + ((limit - used) / perDay) * 86_400_000;
  return { date: bangkokDate(Math.min(at, 8.64e15)), beforeMonthEnd: at < monthEnd };
}

const bangkokDate = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
