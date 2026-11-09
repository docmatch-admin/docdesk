import { supabaseAdmin } from "../supabase/admin";

import type { LineSendKind } from "../line-usage-rules";
export type { LineSendKind };

export interface LineSendMeta {
  kind: LineSendKind;
  conversationId?: string | null;
  /** อายุ replyToken ตอนใช้ (ถ้ามี) */
  tokenAgeMs?: number | null;
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
}

/** บันทึกทุกคำขอส่ง LINE (reply/push) บันทึกไม่ได้ไม่ทำให้การส่งล้ม */
export async function logLineSend(row: LineSendRow): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from("line_sends").insert(row);
    if (error) console.error("line send log failed", error.code);
  } catch (e) {
    console.error("line send log failed", e instanceof Error ? e.message : e);
  }
}
