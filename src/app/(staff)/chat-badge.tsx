"use client";

import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/browser";

export type ChatCounts = { waiting: number; work: number; total: number };

/**
 * ตัวเลข badge เมนู "แชท" (รอตอบ + งานค้าง) — ที่เดียวต่อหน้า ใช้ร่วมกันทุก badge (เมนูซ้าย + แถบล่างมือถือ)
 * - อยู่หน้าแชท: รายการแชทส่งตัวเลขมาให้จากผล /api/inbox/work ชุดเดียวกัน (badge ไม่ยิงเอง)
 * - หน้าอื่น: ยิง /api/inbox/work?counts=1 ครั้งเดียวต่อรอบ (realtime รวมการเปลี่ยนแปลงติดกัน ≥ 2 วิ)
 */
const DEBOUNCE_MS = 2_000;
const POLL_MS = 5 * 60_000;
let current: ChatCounts | null = null;
const listeners = new Set<(c: ChatCounts) => void>();
let owners = 0;
let users = 0;
let channel: RealtimeChannel | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = false;

export function publishChatCounts(c: ChatCounts) {
  current = c;
  for (const l of listeners) l(c);
}

/** หน้าแชทเป็นเจ้าของตัวเลข: badge หยุดดึงเองจนกว่าจะออกจากหน้าแชท (useLayoutEffect = ก่อน badge เริ่มดึง) */
export function useChatCountsOwner() {
  useLayoutEffect(() => {
    owners += 1;
    return () => { owners -= 1; };
  }, []);
}

function fetchCounts() {
  if (owners > 0 || inflight) return;
  inflight = true;
  fetch("/api/inbox/work?counts=1")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j?.counts) publishChatCounts(j.counts); })
    .catch(() => {})
    .finally(() => { inflight = false; });
}

function schedule() {
  if (owners > 0) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; fetchCounts(); }, DEBOUNCE_MS);
}

function start(sb: SupabaseClient) {
  users += 1;
  if (users > 1) return;
  channel = sb.channel("chat-badge").on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, schedule).subscribe();
  poll = setInterval(schedule, POLL_MS);
  if (!current) fetchCounts();
}

function stop(sb: SupabaseClient) {
  users -= 1;
  if (users > 0) return;
  if (channel) sb.removeChannel(channel);
  channel = null;
  if (poll) clearInterval(poll);
  if (timer) clearTimeout(timer);
  poll = null; timer = null;
}

export function ChatBadge({ initial }: { initial?: ChatCounts | null; channel?: string }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [c, setC] = useState<ChatCounts | null>(current ?? initial ?? null);

  useEffect(() => {
    listeners.add(setC);
    if (current) setC(current);
    start(sb);
    return () => { listeners.delete(setC); stop(sb); };
  }, [sb]);

  if (!c?.total) return null;
  return <span className="badge red nav-count" aria-label={`รอตอบ ${c.waiting} งานค้าง ${c.work}`} title={`รอตอบ ${c.waiting} · งานค้าง ${c.work}`}>{c.total}</span>;
}
