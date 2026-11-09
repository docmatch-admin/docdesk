import { supabaseAdmin } from "../supabase/admin";

import type { LineSendKind } from "../line-usage-rules";
export type { LineSendKind };

export interface LineSendMeta {
  kind: LineSendKind;
  conversationId?: string | null;
  /** อายุ replyToken ตอนใช้ (ถ้ามี) */
  tokenAgeMs?: number | null;
  /** ห้าม push: ส่งได้เฉพาะ reply (โควตาเหลือน้อย / ปิดส่งทันทีเมื่อลงนัด) */
  replyOnly?: boolean;
}

export interface LineSendRow {
  conversation_id: string | null;
  mode: "reply" | "push";
  kind: LineSendKind;
  message_count: number;
  ok: boolean;
  fallback: boolean;
  token_age_ms: number | null;
  error: string | null;
  /** push ไม่ผ่านเพราะโควตาเดือนนี้หมด */
  quota_exceeded?: boolean;
}

/** push ไม่ผ่านเพราะโควตาข้อความของเดือนนี้หมด (ไม่ลองซ้ำ) */
export class LineQuotaError extends Error {
  constructor() { super("โควตา LINE เดือนนี้หมด"); this.name = "LineQuotaError"; }
}

/** ไม่ได้ส่ง: ต้อง push แต่ห้าม push (replyOnly) */
export class LinePushSkipped extends Error {
  constructor() { super("งดส่งแบบ push"); this.name = "LinePushSkipped"; }
}

/** LINE ตอบ 429 มีได้ 2 แบบ: โควตารายเดือนหมด กับเรียกถี่เกิน เฉพาะแบบแรกถือว่าโควตาหมด */
export const isMonthlyLimit = (status: number, body: string) => status === 429 && /monthly limit/i.test(body);

/** บันทึกทุกคำขอส่ง LINE (reply/push) บันทึกไม่ได้ไม่ทำให้การส่งล้ม */
export async function logLineSend(row: LineSendRow): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from("line_sends").insert({ quota_exceeded: false, ...row });
    if (error) console.error("line send log failed", error.code);
  } catch (e) {
    console.error("line send log failed", e instanceof Error ? e.message : e);
  }
}

/** เจอโควตาหมด: จำไว้ในฐานข้อมูล แถบแดงขึ้นทันที ไม่ต้องรอรอบตรวจรายชั่วโมง */
export async function markQuotaExhausted(now = Date.now()): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data } = await db.from("settings").select("value").eq("key", "line_quota_state").maybeSingle();
    const prev = (data?.value ?? {}) as Record<string, unknown>;
    await db.from("settings").upsert({ key: "line_quota_state", value: { ...prev, exhausted_at: new Date(now).toISOString() } }, { onConflict: "key" });
  } catch (e) {
    console.error("mark quota exhausted failed", e instanceof Error ? e.message : e);
  }
}
