import { NextResponse } from "next/server";
import { logSystemError } from "@/lib/health";
import { secretMatches } from "@/lib/hr-credentials";
import { hrProviderList, type ProviderRow } from "@/lib/hr-providers";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * HR ดึงรายชื่อแพทย์: Authorization: Bearer HR_CREDENTIAL_SECRET (เหมือน /api/hr/credentials)
 * ตอบ { providers: [{ name, last_seen_at }] } — edge function docdesk-providers ของ HR อ่านรูปแบบนี้ ห้ามเปลี่ยนชื่อ key
 */
export async function GET(req: Request) {
  if (!secretMatches(req.headers.get("authorization"), process.env.HR_CREDENTIAL_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { data, error } = await supabaseAdmin().from("providers").select("name, last_seen_at, active").order("name");
    if (error) throw error;
    return NextResponse.json({ providers: hrProviderList((data ?? []) as ProviderRow[]) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await logSystemError("api:hr-providers", e);
    return NextResponse.json({ error: "อ่านรายชื่อแพทย์ไม่สำเร็จ" }, { status: 500 });
  }
}
