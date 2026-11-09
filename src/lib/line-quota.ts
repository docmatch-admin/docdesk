import { lineQuota } from "./channels/line";
import { bangkokMonthStart, quotaLevel, type LineSendGroup, type QuotaState } from "./line-usage-rules";
import { supabaseAdmin } from "./supabase/admin";

/** อ่านโควตาจาก LINE (quota + consumption) อย่างมากชั่วโมงละครั้ง ระหว่างนั้นบวกข้อความ push ที่ DocDesk ส่งไปแล้ว */
export const QUOTA_REFRESH_MS = 60 * 60_000;

interface Stored { type?: string; limit?: number | null; used?: number; checked_at?: string; month?: string; exhausted_at?: string | null }

const MEMO_MS = 60_000;
let memo: { at: number; value: QuotaState } | null = null;

/** push ที่ DocDesk ส่งสำเร็จหลังเวลาที่อ่านจาก LINE ล่าสุด */
async function pushedSince(iso: string): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("line_send_summary", { p_from: iso });
  if (error) return 0;
  return ((data ?? []) as LineSendGroup[]).filter((r) => r.mode === "push" && r.ok).reduce((n, r) => n + Number(r.messages), 0);
}

export async function lineQuotaState(now = Date.now(), force = false): Promise<QuotaState> {
  if (!force && memo && now - memo.at < MEMO_MS) return memo.value;
  const db = supabaseAdmin();
  const { month } = bangkokMonthStart(now);
  const { data } = await db.from("settings").select("value").eq("key", "line_quota_state").maybeSingle();
  let s = (data?.value ?? {}) as Stored;
  // เดือนใหม่: โควตารีเซ็ต ล้างสถานะหมด
  const stale = !s.checked_at || s.month !== month || now - Date.parse(s.checked_at) >= QUOTA_REFRESH_MS;
  if (stale || force) {
    try {
      const q = await lineQuota();
      const exhausted = s.month === month && s.exhausted_at && q.limit != null && q.used >= q.limit ? s.exhausted_at : null;
      s = { type: q.type, limit: q.limit, used: q.used, checked_at: new Date(now).toISOString(), month, exhausted_at: exhausted };
      await db.from("settings").upsert({ key: "line_quota_state", value: s }, { onConflict: "key" });
    } catch (e) {
      console.error("line quota refresh failed", e instanceof Error ? e.message : e);
    }
  }
  const sameMonth = s.month === month;
  const used = sameMonth ? (s.used ?? 0) + (s.checked_at ? await pushedSince(s.checked_at) : 0) : 0;
  const limit = s.limit ?? null;
  const exhausted = sameMonth && !!s.exhausted_at;
  const value: QuotaState = {
    type: s.type ?? "unknown",
    limit,
    used,
    remaining: limit == null ? null : Math.max(0, exhausted ? 0 : limit - used),
    level: quotaLevel(limit, used, exhausted),
    checkedAt: s.checked_at ?? null,
  };
  memo = { at: now, value };
  return value;
}

export const clearQuotaMemo = () => { memo = null; };
