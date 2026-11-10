import { NextResponse } from "next/server";
import { activeModels, clearModelCache, loadModelSettings, modelEnvFallback } from "@/lib/ai-models";
import { cleanModel, MODEL_NAME, type AiModelSettings } from "@/lib/ai-models-rules";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logSettingsAudit } from "@/lib/settings-audit-store";

export const runtime = "nodejs";

/** โมเดลที่ใช้จริงต่องาน + มาจากหน้าตั้งค่าหรือ env + ค่าที่บันทึกไว้ (ไม่แสดงค่าลับ) */
export async function GET() {
  const { error } = await requireAdmin();
  if (error) return error;
  const [stored, active] = await Promise.all([loadModelSettings(), activeModels(true)]);
  return NextResponse.json({ stored, active, envFallback: modelEnvFallback() }, { headers: { "Cache-Control": "no-store" } });
}

/** { chat, translate, embed } ว่าง = ลบค่าในหน้าตั้งค่า (กลับไปใช้ env/ค่าเริ่มต้น) */
export async function PUT(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const value: AiModelSettings = {};
  for (const k of ["chat", "translate", "embed"] as const) {
    const raw = typeof b[k] === "string" ? (b[k] as string).trim() : "";
    if (raw && !MODEL_NAME.test(raw)) return NextResponse.json({ error: `ชื่อโมเดลไม่ถูกต้อง: ${raw.slice(0, 80)}` }, { status: 400 });
    value[k] = cleanModel(raw);
  }
  const before = await loadModelSettings();
  const { error: dbErr } = await supabaseAdmin().from("settings").upsert({ key: "ai_models", value }, { onConflict: "key" });
  if (dbErr) return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  // เขียนด้วย service role trigger จึงไม่รู้ว่าใครแก้ บันทึกประวัติเองพร้อมชื่อผู้แก้
  if (JSON.stringify(before) !== JSON.stringify(value)) {
    await logSettingsAudit({ actorId: user.id, section: "AI", table: "settings", key: "ai_models", action: "update", oldValue: { key: "ai_models", value: before }, newValue: { key: "ai_models", value } });
  }
  clearModelCache();
  return NextResponse.json({ stored: value, active: await activeModels(true) });
}
