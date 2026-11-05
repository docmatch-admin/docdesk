import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { addNote, NOTE_MAX_CHARS } from "@/lib/team-store";

export const runtime = "nodejs";

/** คอมเมนต์ภายใน: { body, task_id? } เจ้าหน้าที่เห็นเท่านั้น ไม่ส่งถึงลูกค้า */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { body?: unknown; task_id?: unknown };
  const r = await addNote(id, { body: b.body, taskId: b.task_id }, user.id);
  if (r === "invalid") return NextResponse.json({ error: `พิมพ์คอมเมนต์ 1–${NOTE_MAX_CHARS} ตัวอักษร` }, { status: 400 });
  if (r === "not_found") return NextResponse.json({ error: "ไม่พบแชทหรืองานนี้" }, { status: 404 });
  return NextResponse.json({ note: r });
}
