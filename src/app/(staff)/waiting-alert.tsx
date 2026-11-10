"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { shouldAlertStaff } from "@/lib/assignment";
import type { BusinessHoursConfig } from "@/lib/business-hours";
import { titleWithCount } from "@/lib/case-flow";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { usePreferences } from "./preferences";
import { Icon } from "./icons";

const REPEAT_MS = 60_000;
/** นัดที่ยังไม่ลงระบบเตือนทุกเครื่อง ไม่ขึ้นกับผู้ดูแล จนกว่าจะกดลงนัด */
const BOOKING_REPEAT_MS = 3 * 60_000;
/** ต้องประเมินซ้ำเอง เพราะแชทของคนอื่นจะมาแจ้งเราเมื่อครบเวลา โดยไม่มีข้อมูลเปลี่ยน */
const EVALUATE_MS = 30_000;

interface WaitingChat { assigned_to: string | null; waiting_since: string | null; last_inbound_at: string | null }

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
  const [bookingPending, setBookingPending] = useState(0);
  const previousBookings = useRef(0);
  const [hours, setHours] = useState<BusinessHoursConfig>({ tz: "Asia/Bangkok", days: {} });
  const [now, setNow] = useState(() => Date.now());
  // ปิดเสียงที่เครื่องไหน ทุกเครื่องของผู้ใช้คนนี้เงียบตาม (user_preferences + realtime)
  const { prefs, update } = usePreferences();
  const muted = prefs.sound_muted;
  const audio = useRef<AudioContext | null>(null);
  const previous = useRef(0);

  useEffect(() => {
    const load = async () => {
      const { data, count: n } = await sb.from("conversations").select("assigned_to, waiting_since, last_inbound_at, last_direction, booking_pending", { count: "exact" })
        .eq("status", "open").or("last_direction.eq.in,booking_pending.eq.true").limit(500);
      if (n !== null) setCount(n);
      const rows = (data ?? []) as (WaitingChat & { last_direction: string | null; booking_pending: boolean })[];
      setWaiting(rows.filter((c) => c.last_direction === "in"));
      setBookingPending(rows.filter((c) => c.booking_pending).length);
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

  useEffect(() => {
    const play = () => { if (audio.current?.state === "running") beep(audio.current); };
    if (!muted && bookingPending > previousBookings.current) play();
    previousBookings.current = bookingPending;
    if (muted || bookingPending === 0) return;
    const repeat = setInterval(play, BOOKING_REPEAT_MS);
    return () => clearInterval(repeat);
  }, [bookingPending, muted]);

  return (
    <button className="btn ghost small nav-quick" onClick={() => update({ sound_muted: !muted })} aria-pressed={!muted} title="ใช้ค่าเดียวกับ ตั้งค่า → การแสดงผล (ทุกเครื่อง)">
      <Icon name={muted ? "bellOff" : "bell"} size={16} />
      <span>{muted ? "เสียงเตือน: ปิด" : "เสียงเตือน: เปิด"}</span>
    </button>
  );
}
