export type ChannelType = "line" | "web" | "facebook" | "instagram" | "whatsapp";
export type AiMode = "off" | "assist" | "fallback" | "auto";

export const AI_MODE_LABEL: Record<AiMode, string> = {
  off: "ปิด AI",
  assist: "ผู้ช่วย",
  fallback: "คนตอบก่อน",
  auto: "อัตโนมัติ",
};

export const AI_MODE_HINT: Record<AiMode, string> = {
  off: "เจ้าหน้าที่ตอบเองทั้งหมด (ยังเห็นประโยคแนะนำ)",
  assist: "AI ร่างคำตอบ เจ้าหน้าที่กดส่ง",
  fallback: "ถ้าไม่มีใครตอบภายในเวลาที่ตั้ง หรือนอกเวลาทำการ AI ตอบแทน",
  auto: "AI ตอบเองทันที (ยกเว้นเรื่องอาการ/ยา ส่งให้คน)",
};

export const CHANNEL_LABEL: Record<ChannelType, string> = {
  line: "LINE",
  web: "เว็บไซต์",
  facebook: "Facebook",
  instagram: "Instagram",
  whatsapp: "WhatsApp",
};

export type SuggestionSource = "knowledge" | "example" | "history";

export interface SuggestionOption {
  text: string;           // ภาษาไทย (ระบบแปลตอนส่ง)
  source: SuggestionSource;
  ref_ids: string[];      // id ของ knowledge_items / reply_examples ที่ใช้
  confidence: number;     // 0..1
  note?: string;          // เช่น "ราคาในคำตอบเดิมไม่ตรงกับฐานข้อมูล ใช้ราคาใหม่แล้ว"
}

export interface SuggestionResult {
  id: string | null;
  options: SuggestionOption[];
  needs_human: boolean;
  reason?: string;
  suggested_tags?: string[];
  /** ไม่ได้ร่างคำตอบเพราะอะไร: ตอบแล้ว / แค่ขอบคุณหรือรับทราบ / เกินเพดาน / ระบบกำลังร่างอยู่ */
  skipped?: "answered" | "no_reply_needed" | "cap" | "in_progress";
}

export interface Conversation {
  id: string;
  contact_id: string;
  channel_id: string;
  status: "open" | "closed";
  ai_mode: AiMode | null;
  tags: string[];
  unread_count: number;
  needs_human: boolean;
  ai_due_at: string | null;
  last_message_at: string;
  last_message_preview: string | null;
  contacts?: { display_name: string | null; avatar_url: string | null; language: string };
  channels?: { type: ChannelType; name: string; ai_mode: AiMode | null };
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  sender_type: "customer" | "staff" | "ai" | "system";
  body: string;
  body_th: string | null;
  language: string;
  starred: boolean;
  read_by_customer_at: string | null;
  media_type: string | null;
  media_path: string | null;
  media_preview_path: string | null;
  media_width: number | null;
  media_height: number | null;
  media_deleted_at: string | null;
  created_at: string;
}
