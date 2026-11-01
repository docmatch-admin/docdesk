"use client";

import { useCallback, useEffect, useState } from "react";

interface Row { id: string; display_name: string; email: string | null; role: "admin" | "agent"; active: boolean }

export function StaffClient({ meId }: { meId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState("");
  const [secret, setSecret] = useState<{ who: string; password: string } | null>(null);
  const [form, setForm] = useState({ email: "", display_name: "", role: "agent" });

  const load = useCallback(async () => {
    const res = await fetch("/api/staff");
    if (res.ok) setRows(((await res.json()) as { staff: Row[] }).staff);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function patch(id: string, body: Record<string, unknown>, who?: string) {
    setMsg("");
    const res = await fetch("/api/staff", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setMsg(j.error ?? "บันทึกไม่สำเร็จ");
    if (j.password && who) setSecret({ who, password: j.password });
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
    if (!res.ok) return setMsg(j.error ?? "เพิ่มบัญชีไม่สำเร็จ");
    setSecret({ who: form.email, password: j.password });
    setForm({ email: "", display_name: "", role: "agent" });
    load();
  }

  return (
    <div className="page narrow">
      <h1>เจ้าหน้าที่</h1>
      <p className="muted small">admin ทำได้ทุกอย่าง · agent ตอบแชท ติดแท็ก กดดาว และรับเคส แต่แก้ฐานข้อมูล ตั้งค่า จัดการแท็ก ส่งออกข้อมูล และดูรายงานรายละเอียดไม่ได้</p>

      {secret && (
        <section className="card secret-card" role="status">
          <b>รหัสผ่านชั่วคราวของ {secret.who}</b>
          <code>{secret.password}</code>
          <p className="muted small">แสดงครั้งนี้ครั้งเดียว ส่งให้เจ้าของบัญชีทางช่องทางส่วนตัว</p>
          <button className="btn ghost small" onClick={() => setSecret(null)}>ปิด</button>
        </section>
      )}
      {msg && <div className="error small" role="alert">{msg}</div>}

      <section className="card">
        <h3>บัญชี</h3>
        {rows.map((r) => (
          <div key={r.id} className={`tag-row ${r.active ? "" : "off"}`}>
            <input className="grow" defaultValue={r.display_name} aria-label={`ชื่อของ ${r.email}`} onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== r.display_name) patch(r.id, { display_name: v });
            }} />
            <span className="muted small grow">{r.email}{r.id === meId ? " (คุณ)" : ""}</span>
            <select value={r.role} aria-label={`สิทธิ์ของ ${r.email}`} onChange={(e) => patch(r.id, { role: e.target.value })}>
              <option value="agent">agent</option>
              <option value="admin">admin</option>
            </select>
            <button className="btn ghost small" onClick={() => patch(r.id, { reset_password: true }, r.email ?? r.display_name)}>ออกรหัสใหม่</button>
            <button className="btn ghost small" onClick={() => patch(r.id, { active: !r.active })}>{r.active ? "ปิดบัญชี" : "เปิดบัญชี"}</button>
          </div>
        ))}
      </section>

      <form className="card form" onSubmit={add}>
        <h3>เพิ่มบัญชี</h3>
        <label>อีเมล<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <label>ชื่อที่แสดง<input required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></label>
        <label>สิทธิ์
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="agent">agent</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <div className="row"><button className="btn primary">เพิ่มบัญชี</button></div>
      </form>
    </div>
  );
}
