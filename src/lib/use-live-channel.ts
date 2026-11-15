"use client";

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * realtime ที่ซ่อมตัวเองได้ — แก้อาการ "ข้อมูลใหม่ไม่ขึ้น ต้องกด F5"
 *
 * realtime ของ Supabase หลุดเงียบๆ ได้ (เครื่องพัก/จอดับ, เน็ตสะดุด, แท็บอยู่เบื้องหลังนาน)
 * หลุดแล้วไม่มีอะไรเรียกโหลดใหม่ หน้าจอจึงค้างข้อมูลเก่า hook นี้:
 * 1) channel หลุด (CHANNEL_ERROR / TIMED_OUT / CLOSED) → ต่อใหม่เอง หน่วงเพิ่มขึ้นทีละขั้น (2s → 30s)
 * 2) ต่อกลับได้ → resync() ดึงของที่พลาดไประหว่างหลุด
 * 3) กลับมาที่หน้าจอ / เน็ตกลับมา → resync() และถ้า channel ไม่ได้เชื่อมอยู่ก็ต่อใหม่
 * 4) สำรอง: ระหว่างเปิดหน้าจอ resync() ทุก pollMs เผื่อทุกอย่างข้างบนพลาด
 * ไม่ reload ทั้งหน้า ข้อความที่พิมพ์ค้างไว้จึงไม่หาย
 */
export const RESYNC_THROTTLE_MS = 3_000;
export const DEFAULT_POLL_MS = 60_000;
const RETRY_STEPS_MS = [2_000, 5_000, 15_000, 30_000];

export function retryDelay(attempt: number): number {
  return RETRY_STEPS_MS[Math.min(Math.max(attempt, 0), RETRY_STEPS_MS.length - 1)];
}

export function useLiveChannel(
  sb: SupabaseClient,
  /** ชื่อ channel ต้องไม่ซ้ำกันในหน้าเดียว (ใส่ id แชทถ้าผูกกับแชท) */
  name: string | null,
  build: (ch: RealtimeChannel) => RealtimeChannel,
  resync: () => void,
  opts: { pollMs?: number } = {},
): void {
  const buildRef = useRef(build);
  const resyncRef = useRef(resync);
  buildRef.current = build;
  resyncRef.current = resync;
  const [gen, setGen] = useState(0);
  const joined = useRef(false);
  const attempt = useRef(0);
  const lastResync = useRef(0);
  const startedAt = useRef(0);
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;

  // ต่อ channel (gen เปลี่ยน = ต่อใหม่)
  useEffect(() => {
    if (!name) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    joined.current = false;
    startedAt.current = Date.now();
    const ch = buildRef.current(sb.channel(`${name}#${gen}`));
    ch.subscribe((status) => {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        const reconnected = attempt.current > 0 || gen > 0;
        joined.current = true;
        attempt.current = 0;
        if (reconnected) resyncRef.current();
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        joined.current = false;
        if (retry) return;
        retry = setTimeout(() => {
          if (disposed) return;
          attempt.current += 1;
          setGen((g) => g + 1);
        }, retryDelay(attempt.current));
      }
    });
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      sb.removeChannel(ch);
    };
  }, [sb, name, gen]);

  // กลับมาที่หน้าจอ / เน็ตกลับ / สำรองตามรอบ
  useEffect(() => {
    if (!name) return;
    const kick = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastResync.current < RESYNC_THROTTLE_MS) return;
      lastResync.current = now;
      resyncRef.current();
      // ยังไม่เชื่อมทั้งที่ผ่านไปนานพอ (ไม่ใช่กำลังเชื่อมครั้งแรก) → ต่อใหม่
      if (!joined.current && now - startedAt.current > 10_000) { attempt.current = 0; setGen((g) => g + 1); }
    };
    const onVisible = () => { if (document.visibilityState === "visible") kick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", kick);
    window.addEventListener("focus", kick);
    const poll = setInterval(kick, pollMs);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", kick);
      window.removeEventListener("focus", kick);
      clearInterval(poll);
    };
  }, [name, pollMs]);
}
