"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { thaiShortDate } from "@/lib/appointment-rules";
import { cleanProviderName, PROVIDER_STALE_DAYS, providerVisible, type Provider } from "@/lib/providers";
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
  const [loadErr, setLoadErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.from("providers").select("name, last_seen_at, active").order("last_seen_at", { ascending: false });
    // โหลดไม่ได้ต้องบอก ไม่แสดงเป็นรายชื่อว่าง (เคยขึ้น "แสดง 0/0" ตอนตารางยังไม่ถูกสร้าง)
    setLoadErr(error ? (error.code === "42P01" || error.code === "PGRST205" ? "ยังไม่มีตารางรายชื่อผู้นัดในฐานข้อมูล (ต้องรัน migration 053)" : `โหลดรายชื่อไม่สำเร็จ: ${error.message}`) : "");
    if (!error) setRows((data ?? []) as Provider[]);
  }, [sb]);
  useEffect(() => { load(); }, [load]);

  async function setActive(p: Provider, active: boolean | null) {
    setRows((list) => list.map((x) => (x.name === p.name ? { ...x, active } : x)));
    const { error } = await sb.from("providers").update({ active }).eq("name", p.name);
    setMsg(error ? `บันทึกไม่สำเร็จ: ${error.message}` : "");
    if (error) load();
  }

  async function rename(p: Provider, name: string): Promise<boolean> {
    const clean = cleanProviderName(name);
    if (!clean || clean === p.name) return true;
    const { error } = await sb.from("providers").update({ name: clean }).eq("name", p.name);
    if (error) { setMsg(error.code === "23505" ? "มีชื่อนี้แล้ว" : `เปลี่ยนชื่อไม่สำเร็จ: ${error.message}`); return false; }
    setMsg("");
    load();
    return true;
  }

  const shown = rows.filter((p) => providerVisible(p)).length;
  return (
    <SetGroup title="ผู้นัด (แพทย์)" area="providers" side={!loadErr && <span className="chip">แสดง {shown}/{rows.length}</span>}
      info={`แก้ชื่อได้ (นัดเดิมยังเก็บชื่อเดิม) · รายชื่อมาจากชื่อแพทย์ใน visit ของ iService ที่ระบบดึงมา และชื่อที่เคยใช้ในนัด อัปเดตทุกครั้งที่ดึง visit · ไม่พบเกิน ${PROVIDER_STALE_DAYS} วันจะซ่อนเอง ปิด/เปิดเองได้ (มีผลทันที)`}>
      {(loadErr || msg) && <p className="error small slist-msg" role="alert">{loadErr || msg}</p>}
      <ListSection columns={<span>แสดงในฟอร์ม</span>}>
        {rows.length === 0 && !loadErr && <p className="muted small slist-msg">ยังไม่มีรายชื่อ — จะเพิ่มเองเมื่อระบบดึง visit วันนี้จาก iService</p>}
        {rows.map((p) => {
          const visible = providerVisible(p);
          const auto = p.active === null;
          return (
            <div key={p.name} className={`slist-row ${visible ? "" : "off"}`} role="listitem">
              <ProviderNameInput key={p.name} provider={p} onRename={rename} />
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

function ProviderNameInput({ provider, onRename }: { provider: Provider; onRename: (p: Provider, name: string) => Promise<boolean> }) {
  const [v, setV] = useState(provider.name);
  const commit = async () => { if (!(await onRename(provider, v))) setV(provider.name); };
  return (
    <input className="slist-input provider-row-name" value={v} maxLength={120} aria-label={`ชื่อผู้นัด ${provider.name}`}
      onChange={(e) => setV(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") { setV(provider.name); (e.target as HTMLInputElement).blur(); } }} />
  );
}
