import { lineQuota } from "./channels/line";
import { bangkokMonthStart, summarizeLineSends, type LineSendGroup } from "./line-usage-rules";
import { supabaseAdmin } from "./supabase/admin";

/** สรุปการใช้ LINE เดือนนี้ (จาก line_sends) พร้อมโควตาที่ LINE รายงาน */
export async function lineUsage(now = Date.now()) {
  const { month, startIso } = bangkokMonthStart(now);
  const [{ data, error }, quota] = await Promise.all([
    supabaseAdmin().rpc("line_send_summary", { p_from: startIso }),
    lineQuota().then((q) => ({ ...q, error: null as string | null })).catch((e) => {
      console.error("line quota failed", e instanceof Error ? e.message : e);
      return { type: "unknown", limit: null as number | null, used: null as number | null, error: "อ่านโควตาจาก LINE ไม่สำเร็จ" };
    }),
  ]);
  if (error) console.error("line send summary failed", error.code);
  return { ...summarizeLineSends((data ?? []) as LineSendGroup[], month), quota };
}
