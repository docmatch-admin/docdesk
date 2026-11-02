import type { BusinessHoursConfig } from "./business-hours";
import { logSystemError } from "./health";
import { getSetting } from "./mode";
import { buildResponseEvent, DEFAULT_SCORE_RULES, normalizeScoreRules, type ScoreRules } from "./scoring";
import { supabaseAdmin } from "./supabase/admin";

const DUPLICATE_KEY = "23505";

export const loadScoreRules = async (): Promise<ScoreRules> =>
  normalizeScoreRules(await getSetting<unknown>("score_rules", DEFAULT_SCORE_RULES));

/** คะแนนพลาดต้องไม่ทำให้การส่งข้อความหาลูกค้าล้ม */
async function guarded(name: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (e) {
    console.error(`${name} failed`, e);
    await logSystemError(`score:${name}`, e);
  }
}

/** เรียกหลังเจ้าหน้าที่ส่งข้อความสำเร็จ */
export function recordStaffResponse(input: { conversationId: string; replyId: string | null; staffId: string; replyText: string; repliedAt: string }) {
  return guarded("response", async () => {
    if (!input.replyId) return;
    const db = supabaseAdmin();
    const [{ data: conv }, { data: rows }, hours, rules] = await Promise.all([
      db.from("conversations").select("closed_at").eq("id", input.conversationId).maybeSingle(),
      db.from("messages").select("id, direction, body, created_at")
        .eq("conversation_id", input.conversationId).neq("imported", true).order("created_at", { ascending: false }).limit(50),
      getSetting<BusinessHoursConfig>("business_hours", { tz: "Asia/Bangkok", days: {} }),
      loadScoreRules(),
    ]);
    const event = buildResponseEvent({
      conversationId: input.conversationId,
      replyId: input.replyId,
      staffId: input.staffId,
      replyText: input.replyText,
      repliedAt: input.repliedAt,
      messages: (rows ?? []) as { id: string; direction: string; body: string; created_at: string }[],
      closedAt: (conv?.closed_at as string | null) ?? null,
      hours,
      rules,
    });
    if (!event) return;
    const { error } = await db.from("response_events").insert(event);
    if (error && error.code !== DUPLICATE_KEY) throw error;
  });
}

/** +คะแนนให้คนส่งข้อความที่ถูกกดดาว ดาวข้อความตัวเองหรือข้อความของ AI ไม่ได้คะแนน */
export function awardStarPoints(message: { id: string; conversation_id: string; sender_id: string | null; sender_type: string }, starredBy: string) {
  return guarded("star", async () => {
    if (message.sender_type !== "staff" || !message.sender_id || message.sender_id === starredBy) return;
    const rules = await loadScoreRules();
    const { error } = await supabaseAdmin().from("score_events").insert({
      staff_id: message.sender_id, kind: "star", points: rules.starPoints, conversation_id: message.conversation_id, message_id: message.id,
    });
    if (error && error.code !== DUPLICATE_KEY) throw error;
  });
}

/**
 * +คะแนนให้คนที่ตอบล่าสุดเมื่อกดเสร็จแล้ว
 * ต้องมีคำตอบใหม่หลังคะแนนครั้งก่อน กันการกดเปิดใหม่แล้วกดเสร็จซ้ำเพื่อปั๊มคะแนน
 */
export function awardClosePoints(conversationId: string) {
  return guarded("close", async () => {
    const db = supabaseAdmin();
    const { data: last } = await db.from("messages").select("sender_id, created_at")
      .eq("conversation_id", conversationId).eq("direction", "out").eq("sender_type", "staff")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!last?.sender_id) return;
    const { data: previous } = await db.from("score_events").select("created_at")
      .eq("conversation_id", conversationId).eq("kind", "close")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (previous && Date.parse(previous.created_at as string) >= Date.parse(last.created_at as string)) return;
    const rules = await loadScoreRules();
    const { error } = await db.from("score_events").insert({
      staff_id: last.sender_id, kind: "close", points: rules.closePoints, conversation_id: conversationId,
    });
    if (error) throw error;
  });
}
