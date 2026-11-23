import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth";
import type { InboxFilter } from "@/lib/case-flow";
import { INBOX_MAX_PAGE, INBOX_PAGE, inboxList } from "@/lib/inbox-list";
import { serverTiming } from "@/lib/server-timing";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

const FILTERS: InboxFilter[] = ["all", "waiting", "work", "mine", "unassigned"];

/**
 * รายการแชท (คิวงาน 3 ช่วง) ทีละหน้า: ?filter=all|waiting|work|mine &q= &tags=a,b &cursor= &limit=
 * ?id=<แชท> = แถวเดียว (แชทใหม่ที่ realtime แจ้งมา)
 * ตอบ { rows, next, counts (ปุ่มกรอง), badge (เมนูแชท), mode }
 */
export async function GET(req: Request) {
  const t = serverTiming();
  const { user, error } = await t.time("auth", requireStaff());
  if (error) return error;
  const u = new URL(req.url).searchParams;
  const filter = (FILTERS as string[]).includes(u.get("filter") ?? "") ? (u.get("filter") as InboxFilter) : "all";
  const limit = Math.min(INBOX_MAX_PAGE, Math.max(1, Number.parseInt(u.get("limit") ?? "", 10) || INBOX_PAGE));
  const tags = (u.get("tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // client ของผู้ใช้: RLS เดิม (คนไม่มีสิทธิ์ไม่เห็นแชทลับ)
  const db = await supabaseServer();
  const result = await inboxList(db as never, supabaseAdmin() as never, {
    filter, q: u.get("q") ?? "", tags, cursor: u.get("cursor"), limit, meId: user.id, id: u.get("id"),
  }, (label, w) => t.time(label, w));
  return NextResponse.json(result, { headers: t.headers() });
}
