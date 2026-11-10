"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { thaiShortDate } from "@/lib/appointment-rules";
import { PROVIDER_STALE_DAYS, providerVisible, type Provider } from "@/lib/providers";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { SetGroup, Switch } from "./settings-save";
import { ListSection, RowMenu } from "./settings-list";

/**
 * รายชื่อผู้นัด (แพทย์) จาก visit ของ iService และนัดเดิม · แอดมินเลือกให้แสดง/ซ่อนในฟอร์มนัด มีผลทันที
 * ค่าเริ่มต้นอัตโนมัติ: ไม่พบเกิน 180 วันซ่อนเอง
 */
export function ProviderSettings({ initial }: { initial?: Provider[] } = {}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<Provider[]>(initial ?? []);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data } = await sb.from("providers").select("name, last_seen_at, active").order("last_seen_at", { ascending: false });
    setRows((data ?? []) as Provider[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  async function setActive(p: Provider, active: boolean | null) {
    setRows((list) => list.map((x) => (x.name === p.name ? { ...x, active } : x)));
    const { error } = await sb.from("providers").update({ active }).eq("name", p.name);
    setMsg(error ? `บันทึกไม่สำเร็จ: ${error.message}` : "");
    if (error) load();
  }

  const shown = rows.filter((p) => providerVisible(p)).length;
  return (
    <SetGroup title="ผู้นัด (แพทย์)" side={<span className="chip">แสดง {shown}/{rows.length}</span>}
      info={`รายชื่อมาจากชื่อแพทย์ใน visit ของ iService ที่ระบบดึงมา และชื่อที่เคยใช้ในนัด อัปเดตทุกครั้งที่ดึง visit · ไม่พบเกิน ${PROVIDER_STALE_DAYS} วันจะซ่อนเอง ปิด/เปิดเองได้ (มีผลทันที)`}>
      {msg && <p className="error small slist-msg" role="alert">{msg}</p>}
      <ListSection columns={<span>แสดงในฟอร์ม</span>}>
        {rows.length === 0 && <p className="muted small slist-msg">ยังไม่มีรายชื่อ — จะเพิ่มเองเมื่อระบบดึง visit วันนี้จาก iService</p>}
        {rows.map((p) => {
          const visible = providerVisible(p);
          const auto = p.active === null;
          return (
            <div key={p.name} className={`slist-row ${visible ? "" : "off"}`} role="listitem">
              <span className="slist-main provider-row-name">{p.name}</span>
              <span className="slist-spacer" />
              <span className="provider-row-seen">
                พบล่าสุด {thaiShortDate(new Date(p.last_seen_at).toLocaleDateString("sv-SE", { timeZone: "Asia/Bangkok" }))}
                {auto ? (visible ? "" : ` · ซ่อนอัตโนมัติ (เกิน ${PROVIDER_STALE_DAYS} วัน)`) : " · ตั้งเอง"}
              </span>
              <Switch checked={visible} hideLabel label={`แสดง ${p.name} ในฟอร์มนัด`} onChange={(v) => setActive(p, v)} />
              {auto ? <span className="row-menu-spacer" aria-hidden="true" /> : <RowMenu label={p.name} items={[{ label: "กลับเป็นอัตโนมัติ", onSelect: () => setActive(p, null) }]} />}
            </div>
          );
        })}
      </ListSection>
    </SetGroup>
  );
}
