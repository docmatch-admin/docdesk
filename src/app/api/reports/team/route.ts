import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import { buildTeamReport, periodStart, type ResponseRow, type ScoreRow, type TeamPeriod } from "@/lib/scoring";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const PAGE = 1000;

async function fetchAll<T>(load: (from: number, to: number) => PromiseLike<{ data: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data } = await load(start, start + PAGE - 1);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** admin เห็นทุกคน · agent เห็นตัวเลขของตัวเอง และอันดับทีมแบบชื่อกับคะแนนรวม */
export async function GET(req: Request) {
  const { user, role, error } = await requireStaff();
  if (error) return error;
  const param = new URL(req.url).searchParams.get("period");
  const period: TeamPeriod = param === "week" || param === "month" ? param : "day";
  const from = periodStart(period);
  const db = supabaseAdmin();

  const [{ data: staff }, responses, scores] = await Promise.all([
    db.from("staff").select("id, display_name, active"),
    fetchAll<ResponseRow>((a, b) => db.from("response_events").select("replied_by, conversation_id, business_seconds, points").gte("replied_at", from).range(a, b)),
    fetchAll<ScoreRow>((a, b) => db.from("score_events").select("staff_id, points").gte("created_at", from).range(a, b)),
  ]);
  const rows = buildTeamReport(responses, scores, (staff ?? []) as { id: string; display_name: string; active: boolean }[]);
  const ranking = rows.map((r) => ({ staffId: r.staffId, name: r.name, total: r.total, rank: r.rank }));
  return NextResponse.json({ rows: role === "admin" ? rows : rows.filter((r) => r.staffId === user.id), ranking, period });
}
