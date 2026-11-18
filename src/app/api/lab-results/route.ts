import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { serverTiming } from "@/lib/server-timing";
import { parseLabTab } from "@/lib/lab-results-rules";
import { hearingAppointmentsByHn, hearingRequestsByHn, lineReadyHns, labResultSummary, labSyncStatus, labTeamNotifyEnabled, labUnmatchedCount, listLabResults, teamGroupSetting } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/**
 * รายการผลแล็บ ?tab=&q=&id=&from=&to= (วันที่ตรวจ YYYY-MM-DD ตามเวลาไทย) + การ์ดสรุป
 * ?conversation= ผลของคนไข้ที่ผูกกับแชทนี้ (แผงขวา) · ?counts=1 จำนวนรอจับคู่ (badge เมนู)
 */
export async function GET(req: Request) {
  const t = serverTiming();
  const { role, canViewSensitive, error } = await t.time("auth", requireStaff());
  if (error) return error;
  const u = new URL(req.url);
  if (u.searchParams.get("counts")) return NextResponse.json({ unmatched: await t.time("unmatched", labUnmatchedCount()) }, { headers: t.headers() });
  const conversationId = u.searchParams.get("conversation");
  if (conversationId) {
    const denied = await t.time("sensitive", denySensitiveChat(conversationId, canViewSensitive));
    if (denied) return denied;
    return NextResponse.json({ results: await t.time("results", listLabResults({ conversationId })) }, { headers: t.headers() });
  }
  const [results, summary, sync, group] = await t.time("list", Promise.all([
    listLabResults({
      tab: parseLabTab(u.searchParams.get("tab")), q: u.searchParams.get("q") ?? "", id: u.searchParams.get("id"),
      from: u.searchParams.get("from"), to: u.searchParams.get("to"),
    }),
    labResultSummary(),
    labSyncStatus(),
    role === "admin" && labTeamNotifyEnabled() ? teamGroupSetting() : Promise.resolve(null),
  ]));
  const [appointments, lineReady, requests] = await t.time("extra", Promise.all([
    hearingAppointmentsByHn(results.map((r) => r.patient_id ?? "")).catch(() => ({})),
    lineReadyHns(results.filter((r) => r.notify_status === "unreachable").map((r) => r.patient_id)).catch(() => ({})),
    hearingRequestsByHn(results.map((r) => r.patient_id)).catch(() => ({})),
  ]));
  return NextResponse.json({
    results, summary, group, appointments, lineReady, requests,
    sync: { last_ok_at: sync.last_ok_at ?? null, last_run_at: sync.last_run_at ?? null, last_error: sync.last_error ?? null },
  }, { headers: t.headers() });
}
