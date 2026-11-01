import type { SupabaseClient } from "@supabase/supabase-js";

export const REPLY_TOKEN_MAX_AGE_MS = 50_000;

/** ดึง replyToken ที่ยังไม่หมดอายุ (ใช้ได้ครั้งเดียว) — ถ้าได้ ตอบ LINE ฟรีไม่นับโควต้า */
export async function claimReplyToken(
  db: SupabaseClient,
  conversationId: string,
  now = Date.now(),
): Promise<string | undefined> {
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
  return claimed?.length ? token : undefined;
}
