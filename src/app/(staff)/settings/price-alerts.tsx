"use client";

import { thaiDateTime } from "@/lib/time-format";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { SetGroup, useTabAlert } from "./settings-save";

interface Alert { code: string; name: string; message: string; at: string }
interface Status { error: string | null; alerts?: Alert[] }

const timeTh = (iso: string) => thaiDateTime(iso);

/** แสดงเมื่อราคาแพ็กเกจไม่ตรงกับเว็บหรือซิงก์ล้มเหลว */
export function PriceAlerts() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    sb.from("settings").select("value").eq("key", "website_sync").maybeSingle()
      .then(({ data }) => setStatus((data?.value as Status | undefined) ?? null));
  }, [sb]);

  const alerts = status?.alerts ?? [];
  useTabAlert("price", "overview", alerts.length > 0 || !!status?.error);
  if (!alerts.length && !status?.error) return null;

  return (
    <SetGroup title="ราคาจากเว็บ" info="แสดงเมื่อราคาแพ็กเกจในระบบไม่ตรงกับเว็บไซต์ หรือซิงก์ล้มเหลว" side={<span className="chip red">{alerts.length || "!"} รายการ</span>}>
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
    </SetGroup>
  );
}
