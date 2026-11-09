import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * LINE ไม่ระบุอายุ replyToken แน่นอน: รับประกันราว 1 นาที ใช้ได้จริงนานกว่านั้นได้แต่ไม่เกินราว 20 นาที
 * ระบบลอง reply ภายใน 20 นาที (ไม่สำเร็จ push แทนอัตโนมัติ ไม่เสียอะไร)
 * หน้าแชท: เกิน 1 นาทีขึ้น "อาจนับโควตา" เกิน 20 นาทีหรือไม่มี token ขึ้น "จะนับโควตา"
 */
export const REPLY_TOKEN_SURE_MS = 60_000;
export const REPLY_TOKEN_MAX_AGE_MS = 20 * 60_000;

export type QuotaHint = "free" | "maybe" | "push";

/** ส่งครั้งถัดไปของแชท LINE นี้จะนับโควตาไหม (จาก token ที่ยังไม่ถูกใช้และอายุของมัน) */
export function lineQuotaHint(token: string | null | undefined, tokenAt: string | null | undefined, now = Date.now()): QuotaHint {
  if (!token || !tokenAt) return "push";
  const age = now - Date.parse(tokenAt);
  if (!(age >= 0) || age > REPLY_TOKEN_MAX_AGE_MS) return "push";
  return age <= REPLY_TOKEN_SURE_MS ? "free" : "maybe";
}

export interface ClaimedToken { token: string; ageMs: number }

/** ดึง replyToken ที่ยังไม่ถูกใช้และยังไม่หมดอายุ (ใช้ได้ครั้งเดียว) — ถ้าได้ ตอบ LINE ฟรีไม่นับโควต้า */
export async function claimReplyTokenWithAge(
  db: SupabaseClient,
  conversationId: string,
  now = Date.now(),
): Promise<ClaimedToken | undefined> {
  const { data } = await db.from("conversations")
    .select("line_reply_token, line_reply_token_at").eq("id", conversationId).single();
  const token = data?.line_reply_token as string | null | undefined;
  const at = data?.line_reply_token_at ? new Date(data.line_reply_token_at as string).getTime() : 0;
  if (!token || now - at > REPLY_TOKEN_MAX_AGE_MS) return undefined;
  // อัปเดตแบบมีเงื่อนไข: ถ้ามีคนอื่น claim ไปแล้วจะไม่ได้แถวกลับมา
  const { data: claimed } = await db.from("conversations")
    .update({ line_reply_token: null })
    .eq("id", conversationId).eq("line_reply_token", token)
    .select("id");
  return claimed?.length ? { token, ageMs: now - at } : undefined;
}

export async function claimReplyToken(db: SupabaseClient, conversationId: string, now = Date.now()): Promise<string | undefined> {
  return (await claimReplyTokenWithAge(db, conversationId, now))?.token;
}
