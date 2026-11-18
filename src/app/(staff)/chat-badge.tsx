"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Counts = { waiting: number; work: number; total: number };

/** badge เมนู "แชท" = รอตอบ + งานค้าง · layout ไม่วาดใหม่ตอนเปลี่ยนหน้า จึงอัปเดตเองเมื่อแชทเปลี่ยน */
export function ChatBadge({ initial, channel = "chat-badge" }: { initial: Counts; channel?: string }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [c, setC] = useState(initial);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fetch("/api/inbox/work?counts=1").then((r) => (r.ok ? r.json() : null)).then((j) => j?.counts && setC(j.counts)).catch(() => {});
      }, 1500);
    };
    const ch = sb.channel(channel)
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, refresh)
      .subscribe();
    const tick = setInterval(refresh, 5 * 60_000);
    return () => { sb.removeChannel(ch); clearInterval(tick); if (timer) clearTimeout(timer); };
  }, [sb, channel]);

  if (!c.total) return null;
  return <span className="badge red nav-count" aria-label={`รอตอบ ${c.waiting} งานค้าง ${c.work}`} title={`รอตอบ ${c.waiting} · งานค้าง ${c.work}`}>{c.total}</span>;
}
