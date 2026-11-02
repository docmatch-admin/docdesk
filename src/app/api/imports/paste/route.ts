import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { embedMany } from "@/lib/ai";
import { requireAdmin } from "@/lib/auth";
import { MAX_PASTE_PAIRS } from "@/lib/paste-import";
import { scrubPII } from "@/lib/pii";
import { matchSensitive } from "@/lib/sensitive-rules";
import { loadSensitiveKeywords } from "@/lib/sensitive-store";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMBED_BATCH = 96;

/** บันทึกคู่ที่เลือกแล้ว รับเฉพาะคู่คำถามคำตอบ ข้อความดิบที่วางไม่ถูกส่งมาที่นี่ */
export async function POST(req: Request) {
  const { user, error } = await requireAdmin();
  if (error) return error;
  const { pairs } = (await req.json().catch(() => ({}))) as { pairs?: unknown };
  if (!Array.isArray(pairs) || pairs.length > MAX_PASTE_PAIRS) {
    return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  }

  const keywords = await loadSensitiveKeywords();
  let sensitive = 0;
  const seen = new Set<string>();
  const clean: { question: string; answer: string; starred: boolean; hash: string }[] = [];
  let invalid = 0;
  for (const p of pairs as { question?: unknown; answer?: unknown; starred?: unknown }[]) {
    const question = typeof p?.question === "string" ? scrubPII(p.question).trim() : "";
    const answer = typeof p?.answer === "string" ? scrubPII(p.answer).trim() : "";
    if (question.length < 3 || answer.length < 4) {
      invalid++;
      continue;
    }
    if (matchSensitive(`${question}\n${answer}`, keywords)) {
      sensitive++;
      continue;
    }
    const hash = `paste:${crypto.createHash("sha256").update(`${question}\n${answer}`).digest("hex")}`;
    if (seen.has(hash)) continue;
    seen.add(hash);
    clean.push({ question, answer, starred: p.starred === true, hash });
  }

  const db = supabaseAdmin();
  const { data: existing } = clean.length
    ? await db.from("reply_examples").select("import_hash").in("import_hash", clean.map((p) => p.hash))
    : { data: [] };
  const known = new Set(((existing ?? []) as { import_hash: string }[]).map((e) => e.import_hash));
  const fresh = clean.filter((p) => !known.has(p.hash));

  try {
    let saved = 0;
    for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
      const part = fresh.slice(i, i + EMBED_BATCH);
      const embeddings = await embedMany(part.map((p) => p.question));
      const { data, error: dbError } = await db.from("reply_examples").upsert(part.map((p, j) => ({
        question: p.question,
        answer: p.answer,
        starred: p.starred,
        embedding: JSON.stringify(embeddings[j]),
        source: "manual_paste",
        import_hash: p.hash,
        created_by: user.id,
      })), { onConflict: "import_hash", ignoreDuplicates: true }).select("id");
      if (dbError) throw dbError;
      saved += data?.length ?? 0;
    }
    return NextResponse.json({ saved, duplicates: clean.length - fresh.length, invalid, sensitive });
  } catch (e) {
    // ไม่ log เนื้อหาแชท
    console.error("paste import failed", (e as { code?: string }).code ?? (e as Error).name);
    return NextResponse.json({ error: "บันทึกไม่สำเร็จ" }, { status: 500 });
  }
}
