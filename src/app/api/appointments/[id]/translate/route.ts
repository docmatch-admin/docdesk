import { NextResponse } from "next/server";
import { requireAppointmentStaff } from "@/lib/auth";
import { editSlipTranslation, translateSlip } from "@/lib/appointment-store";
import { SLIP_FIELDS, type SlipField } from "@/lib/slip-translate";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/**
 * กด EN บนหน้าพิมพ์ใบนัด: แปลเหตุผลนัด การปฏิบัติตัว หมายเหตุ ชื่อชุดนัด
 * server อ่านต้นฉบับจากนัดเอง ไม่รับข้อความจากหน้าเว็บ และไม่ส่งชื่อ HN เบอร์คนไข้ไปแปล
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  const result = await translateSlip(id);
  if (!result) return NextResponse.json({ error: "ไม่พบนัด" }, { status: 404 });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

/** { field, text } พนักงานแก้คำแปล: ใช้เป็นคำแปลของข้อความนี้ครั้งถัดไป */
export async function PUT(req: Request, { params }: Ctx) {
  const { error } = await requireAppointmentStaff();
  if (error) return error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { field?: unknown; text?: unknown };
  if (!SLIP_FIELDS.includes(b.field as SlipField)) return NextResponse.json({ error: "ช่องไม่ถูกต้อง" }, { status: 400 });
  if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 2000) return NextResponse.json({ error: "ข้อความไม่ถูกต้อง" }, { status: 400 });
  if (!(await editSlipTranslation(id, b.field as SlipField, b.text))) return NextResponse.json({ error: "ไม่พบข้อความนี้ในนัด" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
