"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface Alert { code: string; name: string; message: string; at: string }
interface Status { error: string | null; alerts?: Alert[] }

const timeTh = (iso: string) =>
  new Date(iso).toLocaleString("th-TH", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", timeZone: "Asia/Bangkok" });

/** แสดงเมื่อราคาแพ็กเกจไม่ตรงกับเว็บหรือซิงก์ล้มเหลว */
export function PriceAlerts() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    sb.from("settings").select("value").eq("key", "website_sync").maybeSingle()
      .then(({ data }) => setStatus((data?.value as Status | undefined) ?? null));
  }, [sb]);

  const alerts = status?.alerts ?? [];
  if (!alerts.length && !status?.error) return null;

  return (
    <section className="card">
      <h3>⚠️ ราคาจากเว็บ</h3>
      {status?.error && <p className="small">ซิงก์ล่าสุดไม่สำเร็จ: {status.error}</p>}
      {alerts.map((a) => (
        <p key={`${a.code}${a.at}`} className="small"><b>{a.name}</b> {a.message} <span className="muted">({timeTh(a.at)})</span></p>
      ))}
      {alerts.length > 0 && (
        <button className="btn ghost small" onClick={async () => {
          await fetch("/api/knowledge/sync", { method: "PATCH" });
          setStatus({ error: status?.error ?? null, alerts: [] });
        }}>รับทราบ</button>
      )}
    </section>
  );
}
