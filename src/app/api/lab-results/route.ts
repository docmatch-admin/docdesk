import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { parseLabTab } from "@/lib/lab-results-rules";
import { labSyncStatus, listLabResults, teamGroupSetting } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/** รายการผลแล็บ ?tab=&q=&id= · ?conversation= ผลของคนไข้ที่ผูกกับแชทนี้ (แผงขวา) */
export async function GET(req: Request) {
  const { role, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const u = new URL(req.url);
  const noStore = { headers: { "Cache-Control": "no-store" } };
  const conversationId = u.searchParams.get("conversation");
  if (conversationId) {
    const denied = await denySensitiveChat(conversationId, canViewSensitive);
    if (denied) return denied;
    return NextResponse.json({ results: await listLabResults({ conversationId }) }, noStore);
  }
  const [results, sync, group] = await Promise.all([
    listLabResults({ tab: parseLabTab(u.searchParams.get("tab")), q: u.searchParams.get("q") ?? "", id: u.searchParams.get("id") }),
    labSyncStatus(),
    role === "admin" ? teamGroupSetting() : Promise.resolve(null),
  ]);
  return NextResponse.json({ results, sync: { last_ok_at: sync.last_ok_at ?? null, last_run_at: sync.last_run_at ?? null, last_error: sync.last_error ?? null }, group }, noStore);
}
