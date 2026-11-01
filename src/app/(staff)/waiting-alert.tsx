"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { shouldAlertStaff } from "@/lib/assignment";
import type { BusinessHoursConfig } from "@/lib/business-hours";
import { titleWithCount } from "@/lib/case-flow";
import { supabaseBrowser } from "@/lib/supabase/browser";

const REPEAT_MS = 60_000;
/** ต้องประเมินซ้ำเอง เพราะแชทของคนอื่นจะมาแจ้งเราเมื่อครบเวลา โดยไม่มีข้อมูลเปลี่ยน */
const EVALUATE_MS = 30_000;
const MUTE_KEY = "docdesk_alert_muted";

interface WaitingChat { assigned_to: string | null; waiting_since: string | null; last_inbound_at: string | null }

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

function beep(ctx: AudioContext) {
  [880, 660].forEach((hz, i) => {
    const start = ctx.currentTime + i * 0.18;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.17);
  });
}

/** อยู่ใน layout เพื่อให้เตือนได้ในทุกหน้าของเจ้าหน้าที่ ไม่ใช่แค่หน้าแชท */
export function WaitingAlert({ meId }: { meId: string }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [waiting, setWaiting] = useState<WaitingChat[]>([]);
  const [hours, setHours] = useState<BusinessHoursConfig>({ tz: "Asia/Bangkok", days: {} });
  const [now, setNow] = useState(() => Date.now());
  const [muted, setMuted] = useState(false);
  const audio = useRef<AudioContext | null>(null);
  const previous = useRef(0);

  useEffect(() => { setMuted(readMuted()); }, []);

  useEffect(() => {
    const load = async () => {
      const { data, count: n } = await sb.from("conversations").select("assigned_to, waiting_since, last_inbound_at", { count: "exact" })
        .eq("status", "open").eq("last_direction", "in").limit(500);
      if (n !== null) setCount(n);
      setWaiting((data ?? []) as WaitingChat[]);
    };
    load();
    sb.from("settings").select("value").eq("key", "business_hours").maybeSingle()
      .then(({ data }) => { if (data) setHours(data.value as BusinessHoursConfig); });
    const channel = sb.channel("waiting-alert")
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations" }, load)
      .subscribe();
    // เผื่อ realtime หลุด
    const poll = setInterval(load, REPEAT_MS);
    return () => { sb.removeChannel(channel); clearInterval(poll); };
  }, [sb]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), EVALUATE_MS);
    return () => clearInterval(tick);
  }, []);

  // เสียงเตือนเฉพาะแชทที่เกี่ยวกับเรา ส่วนป้ายบนแท็บยังนับรอตอบทั้งหมด
  const alertCount = useMemo(
    () => waiting.filter((c) => shouldAlertStaff(c, meId, hours, now)).length,
    [waiting, meId, hours, now],
  );

  // เบราว์เซอร์ไม่ให้เล่นเสียงจนกว่าผู้ใช้จะแตะหน้าเว็บ
  useEffect(() => {
    const unlock = () => {
      audio.current ??= new AudioContext();
      audio.current.resume().catch(() => {});
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Next ตั้ง title ใหม่หลังเปลี่ยนหน้า จึงตั้งซ้ำอีกครั้งหลังจากนั้น
  useEffect(() => {
    const apply = () => { document.title = titleWithCount(document.title, count); };
    apply();
    const again = setTimeout(apply, 300);
    return () => clearTimeout(again);
  }, [count, pathname]);

  useEffect(() => {
    const play = () => { if (audio.current?.state === "running") beep(audio.current); };
    if (!muted && alertCount > previous.current) play();
    previous.current = alertCount;
    if (muted || alertCount === 0) return;
    const repeat = setInterval(play, REPEAT_MS);
    return () => clearInterval(repeat);
  }, [alertCount, muted]);

  function toggle() {
    const next = !muted;
    setMuted(next);
    try { localStorage.setItem(MUTE_KEY, next ? "1" : "0"); } catch { /* จำไม่ได้ก็ใช้แค่รอบนี้ */ }
  }

  return (
    <button className="btn ghost small" onClick={toggle} aria-pressed={!muted}>
      {muted ? "🔕 เสียงเตือน: ปิด" : "🔔 เสียงเตือน: เปิด"}
    </button>
  );
}
