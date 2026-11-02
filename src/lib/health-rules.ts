/** ใช้ร่วมกันทั้ง server และหน้าเว็บ */
export const HEALTH_LABEL: Record<string, string> = {
  supabase: "ฐานข้อมูล Supabase",
  openai: "OpenAI",
  line_token: "LINE token",
  line_webhook: "LINE webhook ชี้มาที่ DocDesk",
  meta_token: "Facebook Page token",
  cron_fallback: "Cron รันล่าสุดไม่เกิน 5 นาที",
  webhook_errors: "ไม่มี error ใน webhook 1 ชั่วโมงล่าสุด",
};

export interface HealthRow { check_name: string; ok: boolean; detail: string; checked_at: string }

/** pg_cron เรียกทุก 5 นาที เกินนี้แปลว่าตัวตรวจเองหยุดทำงาน */
export const HEALTH_STALE_MS = 15 * 60 * 1000;

/** ข้อที่ผิดปกติ รวมกรณีไม่มีผลตรวจใหม่ ซึ่งแถบเตือนต้องขึ้นแม้ไม่มีข้อไหนแดง */
export function healthProblems(rows: HealthRow[], now = Date.now()): string[] {
  if (!rows.length) return [];
  const problems = rows.filter((r) => !r.ok).map((r) => HEALTH_LABEL[r.check_name] ?? r.check_name);
  const newest = Math.max(...rows.map((r) => Date.parse(r.checked_at)));
  if (now - newest > HEALTH_STALE_MS) problems.push("ตัวตรวจสุขภาพระบบไม่ได้ทำงาน");
  return problems;
}
