import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { DEFAULT_CLINIC_PROFILE, getSetting } from "@/lib/mode";
import { scrubPII } from "@/lib/pii";
import { matchSensitive } from "@/lib/sensitive-rules";
import { loadSensitiveKeywords } from "@/lib/sensitive-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * ส่งออกคำตอบที่เรียนรู้เป็น JSONL รูปแบบ chat fine-tuning
 * ?min_use=2  → เอาคำตอบที่ติดดาว หรือถูกเลือกใช้ตั้งแต่ N ครั้ง (ค่าเริ่มต้น 2)
 * ?all=1      → เอาทุกคำตอบที่ยังใช้งานอยู่
 */
export async function GET(req: Request) {
  const { error } = await requireAdmin();
  if (error) return error;

  const url = new URL(req.url);
  const all = url.searchParams.get("all") === "1";
  const minUse = Math.max(0, Number(url.searchParams.get("min_use") ?? 2) || 0);

  const profile = await getSetting<{ name: string; tone: string }>("clinic_profile", DEFAULT_CLINIC_PROFILE);
  const system = `คุณคือแอดมินแชทของ ${profile.name} โทนการตอบ: ${profile.tone}`;

  let q = supabaseAdmin().from("reply_examples")
    .select("question, answer, starred, use_count")
    .eq("active", true)
    .order("starred", { ascending: false })
    .order("use_count", { ascending: false })
    .limit(5000);
  if (!all) q = q.or(`starred.eq.true,use_count.gte.${minUse}`);
  const { data, error: e } = await q;
  if (e) return NextResponse.json({ error: e.message }, { status: 500 });

  const keywords = await loadSensitiveKeywords();
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of data ?? []) {
    if (matchSensitive(`${r.question}\n${r.answer}`, keywords)) continue;
    const question = scrubPII(r.question).trim();
    const answer = scrubPII(r.answer).trim();
    if (!question || question === "(ไม่มีคำถาม)" || !answer) continue;
    const key = `${question}\u0000${answer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
        { role: "assistant", content: answer },
      ],
    }));
  }

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(lines.join("\n") + (lines.length ? "\n" : ""), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="docdesk-training-${date}.jsonl"`,
      "X-Example-Count": String(lines.length),
    },
  });
}
