import { supabaseAdmin } from "./supabase/admin";
import type { AiMode } from "./types";

export interface BusinessHours {
  tz: string;
  days: Record<string, [string, string] | null>;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const { data } = await supabaseAdmin().from("settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as T) ?? fallback;
}

/** โหมด AI ที่ใช้จริง: รายแชท > รายช่องทาง > ทั้งระบบ */
export async function resolveAiMode(conv: { ai_mode: AiMode | null }, channel: { ai_mode: AiMode | null }) {
  if (conv.ai_mode) return conv.ai_mode;
  if (channel.ai_mode) return channel.ai_mode;
  return getSetting<AiMode>("ai_mode", "assist");
}

export function isWithinBusinessHours(hours: BusinessHours, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: hours.tz || "Asia/Bangkok",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  const range = hours.days[String(dayIdx)];
  if (!range) return false;
  const cur = `${hh === "24" ? "00" : hh}:${mm}`;
  return cur >= range[0] && cur < range[1];
}
