import { NextResponse } from "next/server";
import { dismissArchivedChat, findArchiveCandidates, mergeArchivedChat, splitImportedHistory } from "@/lib/archive-store";
import { denySensitiveChat, requireStaff } from "@/lib/auth";

export const runtime = "nodejs";

/** แชทเก่าชื่อเดียวกันที่ควรถาม ไม่มีเนื้อหาข้อความ */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  return NextResponse.json({ candidates: await findArchiveCandidates(id, canViewSensitive) });
}

/** action: merge รวม · dismiss ไม่ใช่คนเดียวกัน · split แยกประวัติที่นำเข้า */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; archivedId?: unknown };

  try {
    if (b.action === "split") {
      const result = await splitImportedHistory(id, user.id);
      if (!result) return NextResponse.json({ error: "ไม่มีประวัติที่นำเข้าในแชทนี้" }, { status: 404 });
      if (result === "replied") return NextResponse.json({ error: "ตอบแชทนี้แล้ว ถือว่าเป็นคนเดียวกัน แยกประวัติไม่ได้" }, { status: 409 });
      return NextResponse.json(result);
    }
    if (typeof b.archivedId !== "string") return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    if (b.action === "merge") {
      const result = await mergeArchivedChat(id, b.archivedId, user.id, canViewSensitive);
      if (typeof result === "string") return NextResponse.json({ error: "ไม่พบแชทเก่านี้ หรือชื่อไม่ตรงกัน" }, { status: 404 });
      return NextResponse.json(result);
    }
    if (b.action === "dismiss") {
      if (!(await dismissArchivedChat(id, b.archivedId, user.id, canViewSensitive))) {
        return NextResponse.json({ error: "ไม่พบแชทเก่านี้" }, { status: 404 });
      }
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  } catch (e) {
    console.error("archive action failed", (e as { code?: string }).code ?? (e as Error).name);
    return NextResponse.json({ error: "ทำรายการไม่สำเร็จ" }, { status: 500 });
  }
}
