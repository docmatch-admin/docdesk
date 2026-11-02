import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isValidRecord, type ImportRecord } from "@/lib/line-import";
import { importRoom } from "@/lib/line-import-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

/** นำเข้าทีละห้อง ไฟล์ใหญ่จึงไม่ติดเพดานขนาด request ของ Vercel */
export async function POST(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as {
    batchId?: unknown; key?: unknown; room?: unknown; messages?: unknown; mass?: unknown; historyAllowed?: unknown; chatId?: unknown; archiveUnmatched?: unknown;
  };
  if (typeof b.batchId !== "string" || typeof b.room !== "string" || !b.room.trim()
    || !Array.isArray(b.messages) || !b.messages.every(isValidRecord)) {
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }
  const { data: batch } = await supabaseAdmin().from("import_batches").select("id").eq("id", b.batchId).maybeSingle();
  if (!batch) return NextResponse.json({ error: "ไม่พบชุดนำเข้า" }, { status: 404 });

  try {
    const result = await importRoom(
      b.batchId,
      { key: typeof b.key === "string" ? b.key : b.room, room: b.room.trim(), messages: b.messages as ImportRecord[], chatId: typeof b.chatId === "string" ? b.chatId : null },
      new Set(Array.isArray(b.mass) ? b.mass.filter((t): t is string => typeof t === "string") : []),
      b.historyAllowed === true,
      b.archiveUnmatched === true,
    );
    return NextResponse.json(result);
  } catch (e) {
    // ไม่ log เนื้อหาแชท
    console.error("line import failed", (e as { code?: string }).code ?? (e as Error).name);
    return NextResponse.json({ error: "นำเข้าห้องนี้ไม่สำเร็จ" }, { status: 500 });
  }
}
