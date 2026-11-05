"use client";

import { useState } from "react";
import { thaiDate, thaiTime, thaiWeekday } from "@/lib/booking-rules";
import { Icon } from "../icons";

export interface BookingCardRow {
  id: string;
  service: string;
  date: string;
  time: string;
  name: string | null;
  phone: string | null;
  status: "ai_confirmed" | "recorded" | "cancelled";
}

type BookingForm = { service: string; date: string; time: string; name: string; phone: string };
const EMPTY_FORM: BookingForm = { service: "", date: "", time: "", name: "", phone: "" };

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.ok ? null : ((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
}

function BookingFields({ form, onChange, onSave, onCancel, saveLabel }: {
  form: BookingForm; onChange: (f: BookingForm) => void; onSave: () => void; onCancel: () => void; saveLabel: string;
}) {
  return (
    <form className="booking-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <label>บริการ<input required value={form.service} onChange={(e) => onChange({ ...form, service: e.target.value })} /></label>
      <div className="booking-form-row">
        <label>วันที่<input required type="date" value={form.date} onChange={(e) => onChange({ ...form, date: e.target.value })} /></label>
        <label>เวลา<input required type="time" value={form.time} onChange={(e) => onChange({ ...form, time: e.target.value })} /></label>
      </div>
      <label>ชื่อ<input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} /></label>
      <label>เบอร์<input value={form.phone} onChange={(e) => onChange({ ...form, phone: e.target.value })} /></label>
      <div className="row">
        <button className="btn primary small">{saveLabel}</button>
        <button type="button" className="btn ghost small" onClick={onCancel}>ยกเลิก</button>
      </div>
    </form>
  );
}

/** การ์ดนัดแบบย่อในแผงขวา ปุ่มเป็นไอคอน */
export function BookingCard({ booking: b, onChanged, onReschedule, onError }: {
  booking: BookingCardRow;
  onChanged: () => void;
  onReschedule: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [form, setForm] = useState<BookingForm>({ service: b.service, date: b.date, time: b.time.slice(0, 5), name: b.name ?? "", phone: b.phone ?? "" });
  const pending = b.status === "ai_confirmed";

  async function act(url: string, method: string, body?: unknown) {
    const err = await send(url, method, body);
    if (err) return onError(err);
    setEditing(false);
    setConfirmCancel(false);
    onChanged();
  }

  return (
    <div className={`booking-card ${pending ? "pending" : ""}`}>
      <div className="booking-title">{b.service} · {thaiWeekday(b.date)} {thaiDate(b.date)} {thaiTime(b.time)} น.</div>
      <div className="booking-sub">{b.name || "ไม่มีชื่อ"} · {b.phone || "ไม่มีเบอร์"} · {pending ? "AI รับนัดแล้ว รอลงนัด" : "ลงนัดแล้ว"}</div>
      {editing ? (
        <BookingFields form={form} onChange={setForm} saveLabel="บันทึก"
          onSave={() => act(`/api/bookings/${b.id}`, "PATCH", form)} onCancel={() => setEditing(false)} />
      ) : (
        <div className="icon-row">
          {pending && (
            <button type="button" className="icon-btn primary" aria-label="ลงนัดแล้ว" title="ลงนัดแล้ว"
              onClick={() => act(`/api/bookings/${b.id}/record`, "POST")}><Icon name="check" /></button>
          )}
          <button type="button" className="icon-btn" aria-label="แก้ไขนัด" title="แก้ไขนัด" aria-expanded={editing}
            onClick={() => setEditing(true)}><Icon name="pencil" /></button>
          <button type="button" className="icon-btn" aria-label="ร่างข้อความเลื่อนนัดถึงลูกค้า" title="ร่างข้อความเลื่อนนัดถึงลูกค้า"
            onClick={() => onReschedule(b.id)}><Icon name="message" /></button>
          <button type="button" className={`icon-btn danger ${confirmCancel ? "confirm" : ""}`}
            aria-label={confirmCancel ? "ยืนยันยกเลิกนัด" : "ยกเลิกนัด"} title={confirmCancel ? "กดอีกครั้งเพื่อยืนยันยกเลิกนัด (ไม่ส่งข้อความถึงลูกค้า)" : "ยกเลิกนัด"}
            onClick={() => (confirmCancel ? act(`/api/bookings/${b.id}/cancel`, "POST") : setConfirmCancel(true))}>
            <Icon name="x" />{confirmCancel && <span className="icon-btn-text">ยืนยัน</span>}
          </button>
        </div>
      )}
    </div>
  );
}

/** นัดของแชทนี้ + ทำนัดใหม่ กติกา "ลงนัดก่อน" อยู่ที่ booking_pending ของแชท */
export function BookingsBlock({ conversationId, bookings, blurred, onChanged, onReschedule, onError }: {
  conversationId: string;
  bookings: BookingCardRow[];
  blurred: boolean;
  onChanged: () => void;
  onReschedule: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<BookingForm>(EMPTY_FORM);
  const pending = bookings.some((b) => b.status === "ai_confirmed");

  async function create() {
    const err = await send(`/api/conversations/${conversationId}/bookings`, "POST", form);
    if (err) return onError(err);
    setCreating(false);
    setForm(EMPTY_FORM);
    onChanged();
  }

  return (
    <section className="side-block">
      <div className="side-head">
        <h3>นัดหมาย</h3>
        {pending && <span className="chip red tiny">ยังไม่ลงนัด</span>}
        <button type="button" className="icon-btn" aria-label="ทำนัดใหม่" title="ทำนัดใหม่" aria-expanded={creating}
          onClick={() => setCreating(!creating)}><Icon name="plus" /></button>
      </div>
      {creating && (
        <BookingFields form={form} onChange={setForm} saveLabel="บันทึกนัด" onSave={create} onCancel={() => setCreating(false)} />
      )}
      {bookings.length === 0 && !creating && <div className="muted small">ยังไม่มีนัด</div>}
      <div className={blurred ? "sensitive-blur" : ""}>
        {bookings.map((b) => (
          <BookingCard key={`${b.id}${b.date}${b.time}${b.status}`} booking={b} onError={onError}
            onReschedule={onReschedule} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}
