import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { labErrorResponse } from "@/lib/lab-http";
import { setTeamGroup, teamGroupSetting } from "@/lib/lab-results-store";

export const runtime = "nodejs";

/** กลุ่ม LINE ที่รับแจ้งผลแล็บใหม่ (admin) · { group_id: null } = ปิดแจ้งทีม */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as { group_id?: unknown };
  try {
    await setTeamGroup(typeof b.group_id === "string" ? b.group_id : null);
    return NextResponse.json({ group: await teamGroupSetting() });
  } catch (e) {
    return labErrorResponse(e, "lab-results:team-group");
  }
}
