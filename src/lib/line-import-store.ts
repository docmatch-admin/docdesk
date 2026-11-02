import crypto from "node:crypto";
import { embedMany } from "./ai";
import { createArchivedChat, findArchivedChat } from "./archive-store";
import { buildExamplePairs, historyBody, type ImportRecord, type ImportRoom } from "./line-import";
import { matchSensitive } from "./sensitive-rules";
import { loadSensitiveKeywords, markConversationSensitive } from "./sensitive-store";
import { supabaseAdmin } from "./supabase/admin";

const EMBED_BATCH = 96;
const INSERT_BATCH = 500;

/** key ของห้องแทนชื่อที่แสดงเมื่อมี room_id เพราะชื่อเปลี่ยนได้ */
export const importHash = (room: string, m: ImportRecord) =>
  crypto.createHash("sha256").update(`${room}|${new Date(m.sent_at).toISOString()}|${m.sender}|${m.text}`).digest("hex");

/** ลูกค้า LINE ที่ชื่อตรงพอดีคนเดียว ชื่อซ้ำหรือไม่พบคืน null ห้ามเดา */
export async function matchContacts(names: string[]): Promise<Map<string, string>> {
  const db = supabaseAdmin();
  const { data: channel } = await db.from("channels").select("id").eq("type", "line").order("created_at").limit(1).maybeSingle();
  const found = new Map<string, string>();
  if (!channel || !names.length) return found;
  const { data } = await db.from("contacts").select("id, display_name").eq("channel_id", channel.id).in("display_name", names);
  const rows = (data ?? []) as { id: string; display_name: string }[];
  for (const name of names) {
    const hits = rows.filter((r) => r.display_name === name);
    if (hits.length === 1) found.set(name, hits[0].id);
  }
  return found;
}

/** ข้อความที่จะถูกข้ามเพราะมีในระบบแล้วตั้งแต่เริ่มรับ webhook ของลูกค้าที่จับคู่ได้ */
export async function countOverlap(rooms: { name: string; times: string[] }[], matched: Map<string, string>): Promise<number> {
  const db = supabaseAdmin();
  let overlap = 0;
  for (const room of rooms) {
    const contactId = matched.get(room.name);
    if (!contactId) continue;
    const { data: conv } = await db.from("conversations").select("id").eq("contact_id", contactId).maybeSingle();
    if (!conv) continue;
    const { data: first } = await db.from("messages").select("created_at")
      .eq("conversation_id", conv.id).neq("imported", true).order("created_at").limit(1).maybeSingle();
    if (first) overlap += room.times.filter((t) => Date.parse(t) >= Date.parse(first.created_at as string)).length;
  }
  return overlap;
}

/** ข้อความนำเข้า คืนจำนวนแถวใหม่ */
async function insertHistory(conversationId: string, messages: ImportRecord[], room: ImportRoom, batchId: string): Promise<number> {
  const rows = messages.map((m) => ({
    conversation_id: conversationId,
    direction: m.sender === "customer" ? "in" : "out",
    sender_type: m.sender === "customer" ? "customer" : "staff",
    body: historyBody(m),
    language: "th",
    created_at: new Date(m.sent_at).toISOString(),
    imported: true,
    import_hash: importHash(room.key, m),
    import_batch_id: batchId,
    line_oa_chat_id: room.chatId ?? null,
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { data, error } = await supabaseAdmin().from("messages")
      .upsert(rows.slice(i, i + INSERT_BATCH), { onConflict: "import_hash", ignoreDuplicates: true }).select("id");
    if (error) throw error;
    inserted += data?.length ?? 0;
  }
  return inserted;
}

export interface RoomResult { messages: number; examples: number; matched: boolean; archived: boolean }

/** นำเข้าห้องเดียว เรียกซ้ำได้ แถวที่ hash ซ้ำถูกข้าม */
export async function importRoom(
  batchId: string,
  room: ImportRoom,
  mass: Set<string>,
  historyAllowed: boolean,
  archiveUnmatched = false,
): Promise<RoomResult> {
  const db = supabaseAdmin();
  const result: RoomResult = { messages: 0, examples: 0, matched: false, archived: false };
  const keywords = await loadSensitiveKeywords();
  const sensitive = room.messages.some((m) => matchSensitive(m.text, keywords));

  if (historyAllowed) {
    const contacts = await matchContacts([room.room]);
    const contactId = contacts.get(room.room);
    const { data: conv } = contactId
      ? await db.from("conversations").select("id").eq("contact_id", contactId).maybeSingle()
      : { data: null };
    if (conv) {
      result.matched = true;
      // ติดก่อนบันทึก ข้อความจะได้ไม่เปิดให้คนไม่มีสิทธิ์เห็นแม้ชั่วขณะ
      if (sensitive) await markConversationSensitive(conv.id as string, "นำเข้า");
      // ข้อความตั้งแต่ระบบเริ่มรับ webhook มีอยู่แล้ว นำเข้าเฉพาะที่เก่ากว่า ไม่อย่างนั้นจะซ้ำ และลำดับคิวจะเพี้ยน
      const { data: first } = await db.from("messages").select("created_at")
        .eq("conversation_id", conv.id).neq("imported", true).order("created_at").limit(1).maybeSingle();
      const before = first ? Date.parse(first.created_at as string) : Infinity;
      result.messages += await insertHistory(conv.id as string, room.messages.filter((m) => Date.parse(m.sent_at) < before), room, batchId);
    }
  }

  // จับคู่ไม่ได้: เก็บเป็นแชทเก่า รอเจ้าหน้าที่รวมเมื่อลูกค้ากลับมา ไฟล์รูปแบบเก่าไม่มี chat id จึงไม่สร้าง
  if (!result.matched && archiveUnmatched && room.chatId) {
    const hashes = room.messages.map((m) => importHash(room.key, m));
    const { data: known } = await db.from("messages").select("import_hash").in("import_hash", hashes);
    const seen = new Set(((known ?? []) as { import_hash: string }[]).map((k) => k.import_hash));
    const fresh = room.messages.filter((_, i) => !seen.has(hashes[i]));
    if (fresh.length) {
      // ลำดับในไฟล์อาจย้อนเวลา จึงหาเวลาล่าสุดจริง
      const last = room.messages.reduce((a, b) => (Date.parse(b.sent_at) >= Date.parse(a.sent_at) ? b : a));
      const chatId = (await findArchivedChat(room.chatId))
        ?? (await createArchivedChat(room.room, room.chatId, { at: new Date(last.sent_at).toISOString(), text: historyBody(last) }));
      if (chatId) {
        // ติดก่อนบันทึก
        if (sensitive) await markConversationSensitive(chatId, "นำเข้า");
        result.messages += await insertHistory(chatId, fresh, room, batchId);
        result.archived = true;
      }
    }
  }

  const pairs = sensitive ? [] : buildExamplePairs(room, mass);
  const hashes = pairs.map((p) => importHash(room.key, p.first));
  // ไม่เสียค่า embedding ซ้ำเมื่อนำเข้าไฟล์เดิม
  const { data: existing } = hashes.length
    ? await db.from("reply_examples").select("import_hash").in("import_hash", hashes)
    : { data: [] };
  const known = new Set(((existing ?? []) as { import_hash: string }[]).map((e) => e.import_hash));
  const fresh = pairs.map((p, i) => ({ ...p, hash: hashes[i] })).filter((p) => !known.has(p.hash));

  for (let i = 0; i < fresh.length; i += EMBED_BATCH) {
    const part = fresh.slice(i, i + EMBED_BATCH);
    const embeddings = await embedMany(part.map((p) => p.question));
    const { data, error } = await db.from("reply_examples").upsert(part.map((p, j) => ({
      question: p.question,
      answer: p.answer,
      embedding: JSON.stringify(embeddings[j]),
      source: "line_import",
      import_hash: p.hash,
      import_batch_id: batchId,
      created_at: new Date(p.answeredAt).toISOString(),
    })), { onConflict: "import_hash", ignoreDuplicates: true }).select("id");
    if (error) throw error;
    result.examples += data?.length ?? 0;
  }

  const { data: batch } = await db.from("import_batches").select("rooms, messages_imported, examples_imported").eq("id", batchId).maybeSingle();
  if (batch) {
    await db.from("import_batches").update({
      rooms: (batch.rooms as number) + 1,
      messages_imported: (batch.messages_imported as number) + result.messages,
      examples_imported: (batch.examples_imported as number) + result.examples,
    }).eq("id", batchId);
  }
  return result;
}

/** ซ่อนหรือเปิดคำตอบทั้งชุด ประวัติแชทยังอยู่ */
export async function setBatchHidden(id: string, hidden: boolean): Promise<boolean> {
  const db = supabaseAdmin();
  const { data } = await db.from("import_batches").update({ hidden_at: hidden ? new Date().toISOString() : null }).eq("id", id).select("id");
  if (!data?.length) return false;
  await db.from("reply_examples").update({ active: !hidden }).eq("import_batch_id", id);
  return true;
}
