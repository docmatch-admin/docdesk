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
