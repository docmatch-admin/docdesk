// กฎแจ้งเตือน push — ฟังก์ชันล้วน ทดสอบใน node (scripts/push.test.mjs)
// ข้อความแจ้งเตือนขึ้นบนหน้าจอล็อกและผ่าน push service ภายนอก (Apple/Google/Mozilla):
// ใส่ได้แค่ชื่อแชท + "มีข้อความใหม่" + ช่องทาง ห้ามใส่ HN อาการ ผลแล็บ หรือเนื้อหาข้อความ

export interface PushMessage {
  title: string;
  body: string;
  /** เปิดเมื่อกดแจ้งเตือน */
  url: string;
  /** แจ้งเตือนแชทเดียวกันแทนที่อันเดิม ไม่ซ้อนกันเต็มจอ */
  tag?: string;
  /** จำนวนบนไอคอนแอป (navigator.setAppBadge) */
  badge?: number;
}

export const NEW_MESSAGE_TEXT = "มีข้อความใหม่";
export const ASSIGNED_TEXT = "มีแชทมอบหมายให้คุณ";
export const PUSH_THROTTLE_MS = 60_000;
/** หน้าแชทส่ง heartbeat ทุก 30 วิ เกินนี้ถือว่าไม่ได้ดูแล้ว (ปิดแอป/ล็อกจอ) */
export const PRESENCE_TTL_MS = 75_000;
export const PRESENCE_BEAT_MS = 30_000;
/** หน้าแชทอ่านแชทแล้ว → ให้ตัวเลขบนไอคอนแอปอัปเดต (PushKeeper ฟังอยู่) */
export const BADGE_EVENT = "docdesk:badge";

const CHANNEL_LABEL: Record<string, string> = { line: "LINE", facebook: "Facebook", instagram: "Instagram", web: "เว็บไซต์", webchat: "เว็บไซต์" };
export const channelLabel = (ch: string | null | undefined) => (ch && CHANNEL_LABEL[ch]) || "แชท";

/** ชื่อแชทสำหรับแจ้งเตือน: ตัดตัวเลขยาว (HN/เบอร์) ออกเผื่อชื่อติดมา และจำกัดความยาว */
export function safeChatName(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/\d[\d\s-]{4,}\d/g, "").replace(/\bHN\s*[:#]?\s*\S*/gi, "").replace(/\s+/g, " ").trim();
  if (!clean) return "ลูกค้า";
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}

export const chatUrl = (conversationId: string) => `/inbox?c=${encodeURIComponent(conversationId)}`;

export function newMessagePush(c: { id: string; name: string | null; channel: string | null }): PushMessage {
  return { title: safeChatName(c.name), body: `${NEW_MESSAGE_TEXT} · ${channelLabel(c.channel)}`, url: chatUrl(c.id), tag: `chat-${c.id}` };
}

export function assignedPush(c: { id: string; name: string | null; channel: string | null; sensitive: boolean }): PushMessage {
  // แชทลับ: ไม่บอกชื่อ
  return { title: c.sensitive ? "DocDesk" : safeChatName(c.name), body: `${ASSIGNED_TEXT} · ${channelLabel(c.channel)}`, url: chatUrl(c.id), tag: `assign-${c.id}` };
}

export interface StaffLite { id: string; role: string; active: boolean }

/**
 * ใครได้แจ้งเตือนข้อความใหม่: แชทมีผู้ดูแล → ผู้ดูแลคนเดียว · ไม่มี → เจ้าหน้าที่แชททุกคน (admin/agent ไม่รวมห้องยา)
 * ไม่รวมคนที่เปิดแชทนั้นดูอยู่ · แชทลับไม่ส่งที่นี่ (notifySensitiveChat ส่งข้อความกลางให้คนมีสิทธิ์แล้ว)
 */
export function newMessageAudience(
  c: { assignedTo: string | null; sensitive: boolean },
  staff: StaffLite[],
  viewing: Set<string>,
): string[] {
  if (c.sensitive) return [];
  const chatStaff = staff.filter((s) => s.active && s.role !== "pharmacy");
  const ids = c.assignedTo ? chatStaff.filter((s) => s.id === c.assignedTo).map((s) => s.id) : chatStaff.map((s) => s.id);
  return ids.filter((id) => !viewing.has(id));
}

/** เจ้าหน้าที่ที่กำลังเปิดแชทนี้ (heartbeat ยังไม่หมดอายุ) */
export function viewingStaff(rows: { staff_id: string; conversation_id: string | null; seen_at: string }[], conversationId: string, now: number): Set<string> {
  return new Set(rows.filter((r) => r.conversation_id === conversationId && now - Date.parse(r.seen_at) < PRESENCE_TTL_MS).map((r) => r.staff_id));
}

export function shouldThrottle(lastPushAt: string | null | undefined, now: number): boolean {
  return !!lastPushAt && now - Date.parse(lastPushAt) < PUSH_THROTTLE_MS;
}

// ---------- ฝั่งหน้าจอ: ปุ่มเปิดแจ้งเตือนอยู่ในสถานะไหน ----------

export type PushUiState =
  | "loading"
  | "ios-install-first" // iPhone/iPad ยังไม่ได้เพิ่มลงหน้าจอโฮม: Safari ไม่มี push
  | "unsupported"
  | "denied" // เคยกดไม่อนุญาต: ต้องไปเปิดในตั้งค่าของเครื่อง
  | "off" // ยังไม่เปิด (กดปุ่มแล้วค่อยขอสิทธิ์)
  | "on";

export function pushUiState(s: {
  ready: boolean; isIOS: boolean; isInstalled: boolean; supported: boolean;
  permission: NotificationPermission | null; subscribed: boolean; enabled: boolean;
}): PushUiState {
  if (!s.ready) return "loading";
  if (s.isIOS && !s.isInstalled) return "ios-install-first";
  if (!s.supported) return "unsupported";
  if (s.permission === "denied") return "denied";
  if (s.permission === "granted" && s.subscribed && s.enabled) return "on";
  return "off";
}

/** วิธีเปิดสิทธิ์ใหม่หลังกดปฏิเสธ ตามเครื่อง */
export function deniedHelp(p: { isIOS: boolean; isAndroid: boolean }): string {
  if (p.isIOS) return "เปิดแอป ตั้งค่า ของ iPhone > การแจ้งเตือน > DocDesk > เปิด อนุญาตการแจ้งเตือน แล้วกลับมาเปิด DocDesk ใหม่";
  if (p.isAndroid) return "กดค้างที่ไอคอน DocDesk > ข้อมูลแอป > การแจ้งเตือน > อนุญาต (หรือใน Chrome: แตะ ⋮ > การตั้งค่า > การตั้งค่าเว็บไซต์ > การแจ้งเตือน)";
  return "คลิกไอคอนด้านซ้ายของช่องที่อยู่ (รูปแม่กุญแจ/ปรับแต่ง) > การแจ้งเตือน > อนุญาต แล้วรีเฟรชหน้า";
}

export const PUSH_SNOOZE_KEY = "docdesk.push.snoozeUntil";
