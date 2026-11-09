"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Appointment } from "@/lib/appointment-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { AppointmentDrawer } from "../appointments/appointment-drawer";
import { AppointmentForm, deliveryText, EMPTY_DRAFT, type SaveResult } from "../appointments/appointment-form";
import type { LinkedAccountRow } from "../appointments/linked-accounts";
import { AppointmentsSideView } from "./appointments-side-view";

interface Link_ { hn: string; patient_name: string | null; phone: string | null }

/**
 * นัดครั้งต่อไปของแชทนี้ (กรณีนัดผ่านแชท) ใช้ฟอร์มเดียวกับหน้านัดหมาย
 * แชทผูก HN แล้วเติม HN ชื่อ เบอร์ให้ ยังไม่ผูกให้กรอกเอง
 */
export function AppointmentsBlock({ conversationId, contactName, blurred, isAdmin, onChanged, onMessage }: {
  conversationId: string;
  isAdmin: boolean;
  contactName: string | null;
  blurred: boolean;
  onChanged: () => void;
  onMessage: (msg: string) => void;
}) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<Appointment[]>([]);
  const [past, setPast] = useState<Appointment[]>([]);
  const [link, setLink] = useState<Link_ | null>(null);
  const [accounts, setAccounts] = useState<LinkedAccountRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<{ id: string; edit: boolean } | null>(null);
  // แอดมินยืนยันการจับคู่ HN: ค้นชื่อจาก iService ก่อน แล้วกดยืนยัน
  const [linking, setLinking] = useState(false);
  const [hnInput, setHnInput] = useState("");
  const [preview, setPreview] = useState<{ hn: string; name: string } | null>(null);
  const [linkErr, setLinkErr] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/conversations/${conversationId}/appointments`);
    if (!res.ok) return;
    const j = await res.json();
    setRows(j.appointments as Appointment[]);
    setPast((j.past ?? []) as Appointment[]);
    setLink(j.link as Link_ | null);
    setAccounts((j.accounts ?? []) as LinkedAccountRow[]);
  }, [conversationId]);

  useEffect(() => {
    setRows([]); setPast([]); setLink(null); setAccounts([]); setCreating(false); setOpen(null);
    setLinking(false); setHnInput(""); setPreview(null); setLinkErr("");
    load();
    const ch = sb.channel(`appt-${conversationId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `conversation_id=eq.${conversationId}` }, () => load())
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [sb, conversationId, load]);

  function saved(r: SaveResult) {
    setCreating(false);
    onMessage(r.delivery ? `บันทึกนัดแล้ว · ${deliveryText(r.delivery)}` : "บันทึกนัดแล้ว");
    load();
    onChanged();
  }

  async function checkHn(e: React.FormEvent) {
    e.preventDefault();
    setLinkErr(""); setPreview(null);
    const res = await fetch(`/api/conversations/${conversationId}/patient-link?hn=${encodeURIComponent(hnInput.trim())}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setLinkErr(j.error ?? "ค้นไม่สำเร็จ");
    setPreview(j as { hn: string; name: string });
  }

  async function confirmLink() {
    if (!preview) return;
    const res = await fetch(`/api/conversations/${conversationId}/patient-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hn: preview.hn }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setLinkErr(j.error ?? "ผูกไม่สำเร็จ");
    setLinking(false); setPreview(null); setHnInput("");
    onMessage(`ผูกแชทกับ HN ${preview.hn} แล้ว`);
    load(); onChanged();
  }

  /** ยกเลิกการผูก: แชทนี้ หรือบัญชีอื่นที่ผูก HN เดียวกัน */
  async function unlink(target = conversationId) {
    const res = await fetch(`/api/conversations/${target}/patient-link`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    onMessage(res.ok ? (target === conversationId ? "ยกเลิกการผูก HN แล้ว" : "ยกเลิกการผูกบัญชีแล้ว") : j.error ?? "ยกเลิกไม่สำเร็จ");
    load(); onChanged();
  }

  async function setRelation(acc: LinkedAccountRow, relation: "patient" | "relative") {
    const r = await fetch(`/api/conversations/${acc.conversation_id}/patient-link`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ relation }) });
    onMessage(r.ok ? "แก้ป้ายบัญชีแล้ว" : (await r.json().catch(() => ({}))).error ?? "แก้ป้ายไม่สำเร็จ");
    load(); onChanged();
  }

  const initial = { ...EMPTY_DRAFT, hn: link?.hn ?? "", patient_name: link?.patient_name ?? contactName ?? "", phone: link?.phone ?? "" };

  return (
    <>
      <AppointmentsSideView
        isAdmin={isAdmin} link={link} accounts={link ? accounts : []} upcoming={rows} past={past} blurred={blurred} creating={creating}
        onCreate={() => setCreating(!creating)} onLinkHn={() => setLinking(!linking)} onUnlink={() => unlink()}
        onRelation={setRelation} onDetach={(a) => unlink(a.conversation_id)}
        onOpen={(id) => setOpen({ id, edit: false })} onEdit={(id) => setOpen({ id, edit: true })}
        printHref={(id) => `/appointments/${id}/print?reprint=1`}>
        {linking && !link && (
          <div className="appt-link-box">
            <form className="row" onSubmit={checkHn}>
              <input style={{ flex: 1, width: "auto", minWidth: 0 }} placeholder="HN" value={hnInput} onChange={(e) => { setHnInput(e.target.value); setPreview(null); }} inputMode="numeric" />
              <button className="btn ghost small" disabled={!hnInput.trim()}>ค้นใน iService</button>
            </form>
            {preview && (
              <div className="row">
                <span className="small">ชื่อใน HIS: <b>{preview.name}</b></span>
                <button type="button" className="btn primary small" onClick={confirmLink}>ยืนยันการจับคู่</button>
              </div>
            )}
            {linkErr && <div className="error small" role="alert">{linkErr}</div>}
          </div>
        )}
        {creating && (
          <AppointmentForm compact initial={initial} conversationId={conversationId} onCancel={() => setCreating(false)} onSaved={saved} />
        )}
      </AppointmentsSideView>
      {open && (
        <AppointmentDrawer id={open.id} canOpenChat={false} isAdmin={isAdmin} initialMode={open.edit ? "edit" : "view"} onClose={() => setOpen(null)}
          onChanged={(m) => { if (m) onMessage(m); load(); onChanged(); }} />
      )}
    </>
  );
}
