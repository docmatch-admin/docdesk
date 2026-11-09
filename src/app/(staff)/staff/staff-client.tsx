"use client";

import { useCallback, useEffect, useState } from "react";
import { PrintSlip } from "./print-slip";

interface Row {
  id: string;
  display_name: string;
  email: string | null;
  username: string | null;
  role: "admin" | "agent" | "pharmacy";
  active: boolean;
  must_change_password: boolean;
  can_view_sensitive: boolean;
  hr_employee_id: string | null;
  full_name: string | null;
  position: string | null;
}
interface HrOption { id: string; employee_code: string | null; name: string; employment_status: string | null }
interface Secret { name: string; login: string; password: string }

const EMPTY_FORM = { display_name: "", username: "", role: "agent" };

export function StaffClient({ meId }: { meId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [hrEnabled, setHrEnabled] = useState(false);
  const [hrOptions, setHrOptions] = useState<HrOption[]>([]);
  const [msg, setMsg] = useState("");
  const [secret, setSecret] = useState<Secret | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState("");
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/staff");
    if (!res.ok) return;
    const j = (await res.json()) as { staff: Row[]; hrEnabled: boolean };
    setRows(j.staff);
    setHrEnabled(j.hrEnabled);
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!hrEnabled) return;
    fetch("/api/staff/hr").then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (j) setHrOptions(j.employees);
      else setMsg("อ่านรายชื่อจาก HR ไม่สำเร็จ");
    });
  }, [hrEnabled]);

  async function patch(r: Row, body: Record<string, unknown>) {
    setMsg("");
    setConfirming("");
    const res = await fetch("/api/staff", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setMsg(j.error ?? "บันทึกไม่สำเร็จ");
    if (j.password) setSecret({ name: r.display_name, login: r.username ?? r.email ?? "", password: j.password });
    load();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg(j.error ?? "เพิ่มพนักงานไม่สำเร็จ");
    setSecret({ name: j.display_name, login: j.username, password: j.password });
    setForm(EMPTY_FORM);
    setAdding(false);
    load();
  }

  async function syncHr() {
    setMsg("");
    setSyncing(true);
    const res = await fetch("/api/staff/hr", { method: "POST" });
    setSyncing(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg(j.error ?? "ซิงก์ HR ไม่สำเร็จ");
    const skipped = j.skipped.length ? ` ข้าม: ${j.skipped.join(", ")}` : "";
    setMsg(`ซิงก์แล้ว อัปเดต ${j.updated} บัญชี ปิด ${j.deactivated} บัญชี ไม่ได้จับคู่ ${j.unmatched} คน${skipped}`);
    load();
  }

  /** ปุ่มที่ย้อนกลับไม่ได้ต้องกดซ้ำเพื่อยืนยัน */
  const twoStep = (key: string, run: () => void) => () => {
    if (confirming === key) run();
    else setConfirming(key);
  };

  return (
    <div className="page narrow">
      <div className="row between">
        <h1>เจ้าหน้าที่</h1>
        <div className="row">
          {hrEnabled && <button className="btn ghost small" disabled={syncing} onClick={syncHr}>{syncing ? "กำลังซิงก์…" : "🔄 ซิงก์จาก HR"}</button>}
          <button className="btn primary small" onClick={() => setAdding(!adding)}>เพิ่มพนักงาน</button>
        </div>
      </div>
      <p className="muted small">admin ทำได้ทุกอย่าง · agent ตอบแชท ติดแท็ก กดดาว และรับเคส แต่แก้ฐานข้อมูล ตั้งค่า จัดการแท็ก ส่งออกข้อมูล และดูรายงานรายละเอียดไม่ได้</p>

      {secret && (
        <section className="card secret-card" role="status">
          <b>รหัสชั่วคราวของ {secret.name} ({secret.login})</b>
          <code>{secret.password}</code>
          <p className="muted small">แสดงครั้งนี้ครั้งเดียว ถ้าปิดแล้วต้องรีเซ็ตรหัสใหม่</p>
          <div className="row">
            <button className="btn primary small" onClick={() => window.print()}>🖨 พิมพ์ใบแจ้งรหัส</button>
            <button className="btn ghost small" onClick={() => setSecret(null)}>ปิด</button>
          </div>
          <PrintSlip name={secret.name} login={secret.login} password={secret.password} />
        </section>
      )}
      {msg && <div className="small" role="alert">{msg}</div>}

      {adding && (
        <form className="card form" onSubmit={add}>
          <h3>เพิ่มพนักงาน</h3>
          <label>ชื่อที่แสดง (ชื่อเล่น)<input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
          <label>ชื่อผู้ใช้ (a-z 0-9 . _ ยาว 3–20 ตัว)
            <input required autoCapitalize="none" autoCorrect="off" spellCheck={false} minLength={3} maxLength={20} pattern="[a-zA-Z0-9._]+"
              value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </label>
          <label>สิทธิ์
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="agent">agent</option>
              <option value="admin">admin</option>
                <option value="pharmacy">ห้องยา (นัดหมายเท่านั้น)</option>
            </select>
          </label>
          <div className="row"><button className="btn primary">สร้างบัญชี</button></div>
        </form>
      )}

      <section className="card">
        <h3>บัญชี</h3>
        {rows.map((r) => {
          const isMe = r.id === meId;
          const login = r.username ?? r.email ?? "";
          return (
            <div key={r.id} className={`tag-row staff-row ${r.active ? "" : "off"}`}>
              <input className="grow" defaultValue={r.display_name} aria-label={`ชื่อของ ${login}`} onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== r.display_name) patch(r, { display_name: v });
              }} />
              <span className="muted small grow">
                {login}{isMe ? " (คุณ)" : ""}
                {r.must_change_password && <span className="chip staff-pending">รอเปลี่ยนรหัส</span>}
                {r.full_name && <><br />{r.full_name}{r.position ? ` · ${r.position}` : ""}</>}
              </span>
              <select value={r.role} aria-label={`สิทธิ์ของ ${login}`} onChange={(e) => patch(r, { role: e.target.value })}>
                <option value="agent">agent</option>
                <option value="admin">admin</option>
                <option value="pharmacy">ห้องยา (นัดหมายเท่านั้น)</option>
              </select>
              <label className="raw small" title="admin ดูแชทลับได้เสมอ">
                <input type="checkbox" checked={r.role === "admin" || r.can_view_sensitive} disabled={r.role === "admin" || r.role === "pharmacy"}
                  onChange={(e) => patch(r, { can_view_sensitive: e.target.checked })} /> 🔒 ดูแชทลับ
              </label>
              {hrEnabled && (
                <select value={r.hr_employee_id ?? ""} aria-label={`พนักงาน HR ของ ${login}`} onChange={(e) => patch(r, { hr_employee_id: e.target.value || null })}>
                  <option value="">ไม่จับคู่ HR</option>
                  {hrOptions.map((o) => <option key={o.id} value={o.id}>{o.employee_code ? `${o.employee_code} ` : ""}{o.name}</option>)}
                </select>
              )}
              {!isMe && (
                <button className="btn ghost small" onClick={twoStep(`reset:${r.id}`, () => patch(r, { reset_password: true }))}>
                  {confirming === `reset:${r.id}` ? "ยืนยันรีเซ็ต?" : "รีเซ็ตรหัส"}
                </button>
              )}
              {!isMe && (r.active ? (
                <button className="btn ghost small" onClick={twoStep(`off:${r.id}`, () => patch(r, { active: false }))}>
                  {confirming === `off:${r.id}` ? "ยืนยันปิดบัญชี?" : "ปิดบัญชี"}
                </button>
              ) : (
                <button className="btn ghost small" onClick={() => patch(r, { active: true })}>เปิดบัญชี</button>
              ))}
            </div>
          );
        })}
      </section>
    </div>
  );
}
