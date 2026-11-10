import { supabaseAdmin } from "./supabase/admin";
import { RETENTION_BATCH, monthsInRange, type RetentionRunTotals } from "./retention-rules";

/**
 * รอบลบถาวร (pg_cron วันละครั้ง 03:00 → /api/cron/retention): เรียกฟังก์ชันในฐานข้อมูลทีละชุด ≤ 500 แถว
 * ฟังก์ชันตรวจเงื่อนไขซ้ำ บันทึกตัวเลขสรุปลง retention_stats แล้วลบ ในธุรกรรมเดียว · บันทึกผลแต่ละรอบลง retention_runs
 * หยุดเมื่อไม่มีแถวเหลือ หรือใกล้หมดเวลา (รอบถัดไปทำต่อ)
 */
export async function runRetention(opts: { budgetMs?: number; batch?: number; clock?: () => number } = {}): Promise<RetentionRunTotals & { error: string | null }> {
  const db = supabaseAdmin();
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budget = opts.budgetMs ?? 45_000;
  const batch = Math.min(RETENTION_BATCH, Math.max(1, opts.batch ?? RETENTION_BATCH));
  const totals: RetentionRunTotals = { tasks: 0, notes: 0, appointments: 0, events: 0, series: 0, batches: 0 };
  let error: string | null = null;

  const { data: run } = await db.from("retention_runs").insert({ started_at: new Date(started).toISOString() }).select("id").single();

  const loop = async (fn: string, add: (r: Record<string, number>) => number) => {
    while (clock() - started < budget) {
      const { data, error: e } = await db.rpc(fn, { p_limit: batch });
      if (e) throw new Error(`${fn}: ${e.message}`);
      totals.batches++;
      if (add((data ?? {}) as Record<string, number>) < batch) return;
    }
  };
  try {
    await loop("retention_delete_tasks", (r) => { totals.tasks += r.tasks ?? 0; totals.notes += r.notes ?? 0; return r.tasks ?? 0; });
    await loop("retention_delete_appointments", (r) => {
      totals.appointments += r.appointments ?? 0; totals.events += r.events ?? 0; totals.series += r.series ?? 0; return r.appointments ?? 0;
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const row = {
    finished_at: new Date(clock()).toISOString(), tasks_deleted: totals.tasks, notes_deleted: totals.notes, appointments_deleted: totals.appointments,
    events_deleted: totals.events, series_deleted: totals.series, batches: totals.batches, error,
  };
  if (run?.id) await db.from("retention_runs").update(row).eq("id", run.id);
  return { ...totals, error };
}

export interface MonthlySummary {
  month: string;
  tasksByAssignee: Record<string, number>;
  cancelledByReason: Record<string, number>;
  cancelledByPurpose: Record<string, number>;
}

const add = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };

/** ช่วงเวลา UTC ของเดือนตามเวลาไทย */
function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) - 7 * 3600_000).toISOString();
  const end = new Date(Date.UTC(y, m, 1) - 7 * 3600_000).toISOString();
  const lastDay = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start, end, firstDay: `${month.slice(0, 7)}-01`, lastDay };
}

/**
 * ตัวเลขรายเดือน = แถวที่ยังอยู่ + ตัวเลขที่บันทึกไว้ก่อนลบ (retention_stats)
 * แถวที่ลบแล้วไม่อยู่ในตาราง จึงไม่นับซ้ำ รายงานเดือนเก่าได้ตัวเลขเดิม
 */
export async function monthlySummary(month: string): Promise<MonthlySummary> {
  const db = supabaseAdmin();
  const { start, end, firstDay, lastDay } = monthBounds(month);
  const [{ data: tasks }, { data: appts }, { data: stats }] = await Promise.all([
    db.from("chat_tasks").select("assignee_id").eq("done", true).gte("done_at", start).lt("done_at", end),
    db.from("appointments").select("cancel_reason_code, purpose_text").eq("status", "cancelled").gte("appoint_date", firstDay).lte("appoint_date", lastDay),
    db.from("retention_stats").select("metric, dim, key, count").eq("month", firstDay),
  ]);
  const out: MonthlySummary = { month: firstDay, tasksByAssignee: {}, cancelledByReason: {}, cancelledByPurpose: {} };
  for (const t of (tasks ?? []) as { assignee_id: string | null }[]) add(out.tasksByAssignee, t.assignee_id ?? "none");
  for (const a of (appts ?? []) as { cancel_reason_code: string | null; purpose_text: string | null }[]) {
    add(out.cancelledByReason, a.cancel_reason_code ?? "none");
    add(out.cancelledByPurpose, a.purpose_text?.trim() || "none");
  }
  for (const s of (stats ?? []) as { metric: string; dim: string; key: string; count: number }[]) {
    if (s.metric === "tasks_done" && s.dim === "assignee") add(out.tasksByAssignee, s.key, s.count);
    if (s.metric === "appointments_cancelled" && s.dim === "cancel_reason") add(out.cancelledByReason, s.key, s.count);
    if (s.metric === "appointments_cancelled" && s.dim === "purpose") add(out.cancelledByPurpose, s.key, s.count);
  }
  return out;
}

/**
 * งานที่เสร็จต่อผู้รับตั้งแต่ from (ISO) ถึงตอนนี้ สำหรับรายงานทีม: แถวที่ยังอยู่ + สถิติของเดือนที่อยู่ในช่วงทั้งเดือน
 * (เดือนที่เริ่มก่อน from ไม่นับสถิติ เพราะสถิติเป็นรายเดือน แถวที่ลบแล้วเก่ากว่าระยะเก็บอยู่แล้ว)
 */
export async function tasksDoneByAssignee(fromIso: string, now = Date.now()): Promise<Record<string, number>> {
  const db = supabaseAdmin();
  const fromDay = new Date(Date.parse(fromIso) + 7 * 3600_000).toISOString().slice(0, 10);
  const today = new Date(now + 7 * 3600_000).toISOString().slice(0, 10);
  const months = monthsInRange(fromDay, today).filter((m) => m >= fromDay);
  const [{ data: tasks }, { data: stats }] = await Promise.all([
    db.from("chat_tasks").select("assignee_id").eq("done", true).gte("done_at", fromIso),
    months.length ? db.from("retention_stats").select("key, count").eq("metric", "tasks_done").eq("dim", "assignee").in("month", months) : Promise.resolve({ data: [] }),
  ]);
  const out: Record<string, number> = {};
  for (const t of (tasks ?? []) as { assignee_id: string | null }[]) add(out, t.assignee_id ?? "none");
  for (const s of (stats ?? []) as { key: string; count: number }[]) add(out, s.key, s.count);
  return out;
}
