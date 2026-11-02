import crypto from "node:crypto";
import { MediaError, processImage, type ProcessedImage } from "./media";
import { DEFAULT_RETENTION_DAYS, normalizeRetentionDays } from "./media-url";
import { getSetting } from "./mode";
import { DEFAULT_SENSITIVE_RETENTION_DAYS } from "./sensitive-rules";
import { supabaseAdmin } from "./supabase/admin";

export const CHAT_BUCKET = "chat-media";
export const QUICK_BUCKET = "quick-media";
export const IMAGE_FAILED_TEXT = "[รูปภาพ — โหลดไม่สำเร็จ เปิดดูในแอปต้นทาง]";
const WIDGET_URL_TTL_SECONDS = 600;
const STALE_UPLOAD_MS = 60 * 60 * 1000;

export interface StoredMedia { path: string; previewPath: string; width: number; height: number }

export async function storeImage(bucket: string, img: ProcessedImage): Promise<StoredMedia> {
  const db = supabaseAdmin();
  const base = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;
  const path = `${base}.jpg`;
  const previewPath = `${base}_p.jpg`;
  for (const [p, data] of [[path, img.main], [previewPath, img.preview]] as const) {
    const { error } = await db.storage.from(bucket).upload(p, data, { contentType: "image/jpeg" });
    if (error) throw error;
  }
  return { path, previewPath, width: img.width, height: img.height };
}

export async function removeFiles(bucket: string, paths: string[]) {
  const { error } = await supabaseAdmin().storage.from(bucket).remove(paths);
  if (error) console.error("remove media failed", error);
}

export async function downloadFile(bucket: string, path: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin().storage.from(bucket).download(path);
  if (error || !data) throw error ?? new Error("download failed");
  return Buffer.from(await data.arrayBuffer());
}

/**
 * ลิงก์ให้เบราว์เซอร์อัปโหลดตรงเข้า Storage เพราะ Vercel รับ request ได้ไม่เกิน 4.5MB
 * ไฟล์พักอยู่ใน uploads/ จนกว่า server จะตรวจและบีบอัด
 */
export async function createUploadSlot(prefix: string) {
  const path = `uploads/${prefix}-${crypto.randomUUID()}`;
  const { data, error } = await supabaseAdmin().storage.from(CHAT_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw error ?? new Error("create upload url failed");
  return { path, url: data.signedUrl };
}

/** อ่านไฟล์พัก ตรวจ บีบอัด แล้วเก็บจริง ไฟล์พักถูกลบเสมอ แม้ไฟล์ไม่ผ่าน */
export async function consumeUpload(uploadPath: string, bucket: string, maxBytes?: number): Promise<StoredMedia> {
  let raw: Buffer;
  try {
    raw = await downloadFile(CHAT_BUCKET, uploadPath);
  } catch (e) {
    console.error("read upload failed", e);
    throw new MediaError("unsupported");
  }
  try {
    return await storeImage(bucket, await processImage(raw, maxBytes));
  } finally {
    await removeFiles(CHAT_BUCKET, [uploadPath]);
  }
}

/** รูปเข้าจาก LINE/Meta: ลิงก์ต้นทางหมดอายุ ต้องโหลดทันที ถ้าไม่ได้ให้เจ้าหน้าที่ไปดูในแอปต้นทาง */
export async function ingestInboundImage(messageId: string, download: () => Promise<Buffer>) {
  const db = supabaseAdmin();
  try {
    const stored = await storeImage(CHAT_BUCKET, await processImage(await download()));
    await db.from("messages").update({
      media_path: stored.path,
      media_preview_path: stored.previewPath,
      media_width: stored.width,
      media_height: stored.height,
    }).eq("id", messageId);
  } catch (e) {
    console.error("ingest image failed", e);
    await db.from("messages").update({ body: IMAGE_FAILED_TEXT, media_type: null }).eq("id", messageId);
  }
}

export interface WidgetMessage {
  id: string; direction: string; body: string; created_at: string;
  media_url?: string; preview_url?: string; media_deleted?: boolean;
}

/** แนบ signed URL อายุสั้นให้ข้อความที่ผ่านการกรองตาม session มาแล้ว */
export async function attachWidgetMedia(rows: {
  id: string; direction: string; body: string; created_at: string;
  media_path?: string | null; media_preview_path?: string | null; media_deleted_at?: string | null;
}[]): Promise<WidgetMessage[]> {
  const paths = rows.flatMap((r) => (r.media_path && r.media_preview_path ? [r.media_path, r.media_preview_path] : []));
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabaseAdmin().storage.from(CHAT_BUCKET).createSignedUrls(paths, WIDGET_URL_TTL_SECONDS);
    for (const u of data ?? []) if (u.path && u.signedUrl) urls.set(u.path, u.signedUrl);
  }
  return rows.map((r) => ({
    id: r.id, direction: r.direction, body: r.body, created_at: r.created_at,
    ...(r.media_path ? { media_url: urls.get(r.media_path), preview_url: urls.get(r.media_preview_path ?? "") } : {}),
    ...(r.media_deleted_at ? { media_deleted: true } : {}),
  }));
}

/** จำนวนวันเก็บรูปในหน้าตั้งค่า ใช้ทั้งการลบตามอายุและอายุลายเซ็น URL */
export async function loadRetentionDays() {
  return normalizeRetentionDays(await getSetting<unknown>("media_retention_days", DEFAULT_RETENTION_DAYS));
}

/** ลบรูปในแชทที่เก่าเกินกำหนด ข้อความยังอยู่ ไม่แตะ quick-media เพราะรูปในแชทเป็นสำเนาแยก */
export async function purgeExpiredMedia(now = Date.now()) {
  const db = supabaseAdmin();
  const days = await loadRetentionDays();
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: general } = await db.from("messages").select("id, media_path, media_preview_path")
    .not("media_path", "is", null).lt("created_at", cutoff).limit(100);
  // แชทลับเก็บสั้นกว่า ตั้งได้ในหน้าตั้งค่า
  const { data: sensitiveChats } = await db.from("conversations").select("id").eq("sensitive", true);
  const sensitiveIds = (sensitiveChats ?? []).map((c) => c.id as string);
  const sensitiveDays = normalizeRetentionDays(await getSetting<unknown>("sensitive_media_retention_days", DEFAULT_SENSITIVE_RETENTION_DAYS));
  const { data: sensitive } = sensitiveIds.length
    ? await db.from("messages").select("id, media_path, media_preview_path")
        .in("conversation_id", sensitiveIds).not("media_path", "is", null)
        .lt("created_at", new Date(now - sensitiveDays * 86_400_000).toISOString()).limit(100)
    : { data: [] };
  const rows = [...new Map([...(general ?? []), ...(sensitive ?? [])].map((r) => [r.id, r])).values()];
  if (!rows.length) return 0;

  const paths = rows.flatMap((r) => [r.media_path as string, r.media_preview_path as string].filter(Boolean));
  const { error } = await db.storage.from(CHAT_BUCKET).remove(paths);
  if (error) throw error;
  await db.from("messages")
    .update({ media_path: null, media_preview_path: null, media_deleted_at: new Date(now).toISOString() })
    .in("id", rows.map((r) => r.id));
  return rows.length;
}

/** ไฟล์พักที่อัปโหลดแล้วไม่ได้ส่งต่อ */
export async function purgeStaleUploads(now = Date.now()) {
  const bucket = supabaseAdmin().storage.from(CHAT_BUCKET);
  const { data } = await bucket.list("uploads", { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  const stale = (data ?? [])
    .filter((f) => f.created_at && now - Date.parse(f.created_at) > STALE_UPLOAD_MS)
    .map((f) => `uploads/${f.name}`);
  if (stale.length) await removeFiles(CHAT_BUCKET, stale);
  return stale.length;
}
