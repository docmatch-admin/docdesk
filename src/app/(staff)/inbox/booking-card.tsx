"use client";

import { useState } from "react";
import { thaiDate, thaiTime, thaiWeekday } from "@/lib/booking-rules";

export interface BookingCardRow {
  id: string;
  service: string;
  date: string;
  time: string;
  name: string | null;
  phone: string | null;
  status: "ai_confirmed" | "recorded" | "cancelled";
}

/** การ์ดนัดในห้องแชท แก้รายละเอียดได้ก่อนลงนัดจริง */
export function BookingCard({ booking: b, onChanged, onReschedule, onError }: {
  booking: BookingCardRow;
  onChanged: () => void;
  onReschedule: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ service: b.service, date: b.date, time: b.time.slice(0, 5), name: b.name ?? "", phone: b.phone ?? "" });
  const pending = b.status === "ai_confirmed";

  async function save() {
    const res = await fetch(`/api/bookings/${b.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) return onError((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
    setEditing(false);
    onChanged();
  }

  async function record() {
    const res = await fetch(`/api/bookings/${b.id}/record`, { method: "POST" });
    if (!res.ok) return onError((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
    onChanged();
  }

  return (
    <div className={`booking-card ${pending ? "pending" : ""}`}>
      <div className="row between">
        <b>{pending ? "📅 ยังไม่ลงนัด" : "📅 ลงนัดแล้ว"}</b>
        <div className="row">
          {pending && <button className="btn primary small" onClick={record}>✓ ลงนัดแล้ว</button>}
          <button className="btn ghost small" onClick={() => onReschedule(b.id)}>เลื่อน/ยกเลิก</button>
          <button className="btn ghost small" aria-expanded={editing} onClick={() => setEditing(!editing)}>แก้ไข</button>
        </div>
      </div>
      {editing ? (
        <div className="booking-form">
          <label>บริการ<input value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} /></label>
          <label>วันที่<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
          <label>เวลา<input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
          <label>ชื่อ<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>เบอร์<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <button className="btn primary small" onClick={save}>บันทึก</button>
        </div>
      ) : (
        <div className="small">
          {b.service} · วัน{thaiWeekday(b.date)}ที่ {thaiDate(b.date)} เวลา {thaiTime(b.time)} น.
          {" · "}{b.name || "ไม่มีชื่อ"} · {b.phone || "ไม่มีเบอร์"}
        </div>
      )}
    </div>
  );
}
