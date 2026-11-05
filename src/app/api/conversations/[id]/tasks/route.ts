import { NextResponse } from "next/server";
import { denySensitiveChat, requireStaff } from "@/lib/auth";
import { createTask, setTaskDone, TASK_MAX_CHARS } from "@/lib/team-store";

export const runtime = "nodejs";

const PROBLEM = {
  invalid: { status: 400, error: `พิมพ์งาน 1–${TASK_MAX_CHARS} ตัวอักษร` },
  not_found: { status: 404, error: "ไม่พบแชทหรืองานนี้" },
  assignee: { status: 400, error: "เลือกผู้รับงานคนนี้ไม่ได้" },
} as const;

/** เพิ่มงาน: { text, assignee_id? } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { text?: unknown; assignee_id?: unknown };
  const r = await createTask(id, { text: b.text, assigneeId: b.assignee_id }, user.id);
  if (typeof r === "string") return NextResponse.json({ error: PROBLEM[r].error }, { status: PROBLEM[r].status });
  return NextResponse.json({ task: r });
}

/** ติ๊กหรือยกเลิกติ๊ก: { task_id, done } */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, canViewSensitive, error } = await requireStaff();
  if (error) return error;
  const { id } = await params;
  const denied = await denySensitiveChat(id, canViewSensitive);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as { task_id?: unknown; done?: unknown };
  if (typeof b.task_id !== "string" || typeof b.done !== "boolean") return NextResponse.json({ error: "ข้อมูลไม่ครบ" }, { status: 400 });
  const r = await setTaskDone(id, b.task_id, b.done, user.id);
  if (typeof r === "string") return NextResponse.json({ error: PROBLEM[r].error }, { status: PROBLEM[r].status });
  return NextResponse.json({ task: r });
}
