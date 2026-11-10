import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { loadPreferences, savePreferences } from "@/lib/preferences-store";
import { PREF_COOKIE, type Preferences } from "@/lib/theme";

export const runtime = "nodejs";

const KEYS: (keyof Preferences)[] = ["theme", "sound_muted", "push_enabled", "nav_collapsed", "font_size"];
const YEAR = 60 * 60 * 24 * 365;

/** cookie ที่ server ใช้วาด <html> ครั้งถัดไป (ไม่ใช่ข้อมูลลับ) */
function withCookies(res: NextResponse, p: Preferences) {
  const opts = { path: "/", maxAge: YEAR, sameSite: "lax" as const };
  res.cookies.set(PREF_COOKIE.theme, p.theme, opts);
  res.cookies.set(PREF_COOKIE.font, p.font_size, opts);
  res.cookies.set(PREF_COOKIE.nav, p.nav_collapsed ? "collapsed" : "open", opts);
  return res;
}

/** ตั้งค่าส่วนตัวของผู้ใช้ที่ล็อกอิน (ทุก role) */
export async function GET() {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const prefs = await loadPreferences(user.id);
  return withCookies(NextResponse.json(prefs, { headers: { "Cache-Control": "no-store" } }), prefs);
}

/** แก้ได้เฉพาะของตัวเอง รับเฉพาะคีย์ที่รู้จัก ค่าแปลก ๆ ถูกปรับเป็นค่าที่ใช้ได้ */
export async function PUT(req: Request) {
  const { user, error } = await requireAppointmentStaff();
  if (error) return error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => KEYS.includes(k as keyof Preferences)));
  if (!Object.keys(patch).length) return NextResponse.json({ error: "ไม่มีค่าที่แก้ได้" }, { status: 400 });
  try {
    const prefs = await savePreferences(user.id, patch);
    return withCookies(NextResponse.json(prefs), prefs);
  } catch {
    return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  }
}
