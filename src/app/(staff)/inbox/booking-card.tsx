"use client";

import { useState } from "react";
import { bangkokToday } from "@/lib/appointment-rules";
import { thaiDate, thaiTime, thaiWeekday } from "@/lib/booking-rules";
import { AppointmentForm, deliveryText, EMPTY_DRAFT } from "../appointments/appointment-form";
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

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return res.ok ? null : ((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
}

/**
 * นัดที่ AI รับไว้ในแชท: กด "แปลงเป็นนัด" เพื่อบันทึกเป็นนัดจริงในระบบนัด
 * บันทึกแล้ว booking เป็น recorded ป้าย "ลงนัดก่อน" หาย และคนไข้ได้ข้อความนัดพร้อมปุ่มยืนยัน
 */
export function BookingCard({ booking: b, conversationId, contactName, onChanged, onReschedule, onError }: {
  booking: BookingCardRow;
  conversationId: string;
  contactName: string | null;
  onChanged: () => void;
  onReschedule: (id: string) => void;
  onError: (message: string) => void;
}) {
  const [converting, setConverting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const today = bangkokToday();

  async function cancel() {
    const err = await send(`/api/bookings/${b.id}/cancel`, "POST");
    setConfirmCancel(false);
    if (err) return onError(err);
    onChanged();
  }

  return (
    <div className="booking-card pending">
      <div className="booking-title">{b.service} · {thaiWeekday(b.date)} {thaiDate(b.date)} {thaiTime(b.time)} น.</div>
      <div className="booking-sub">{b.name || "ไม่มีชื่อ"} · {b.phone || "ไม่มีเบอร์"} · AI รับนัดแล้ว รอลงนัด</div>
      {converting ? (
        <AppointmentForm compact conversationId={conversationId} bookingId={b.id} saveLabel="บันทึกเป็นนัด"
          initial={{
            ...EMPTY_DRAFT,
            patient_name: b.name || contactName || "",
            phone: b.phone ?? "",
            appoint_date: b.date >= today ? b.date : "",
            appoint_time: b.time.slice(0, 5),
            purpose: b.service,
          }}
          onCancel={() => setConverting(false)}
          onSaved={(r) => { setConverting(false); onError(`ลงนัดแล้ว · ${deliveryText(r.delivery)}`); onChanged(); }} />
      ) : (
        <div className="icon-row">
          <button type="button" className="icon-btn primary" aria-label="แปลงเป็นนัด" title="แปลงเป็นนัด (บันทึกนัดจริง)"
            onClick={() => setConverting(true)}><Icon name="check" /></button>
          <button type="button" className="icon-btn" aria-label="ร่างข้อความเลื่อนนัดถึงลูกค้า" title="ร่างข้อความเลื่อนนัดถึงลูกค้า"
            onClick={() => onReschedule(b.id)}><Icon name="message" /></button>
          <button type="button" className={`icon-btn danger ${confirmCancel ? "confirm" : ""}`}
            aria-label={confirmCancel ? "ยืนยันยกเลิกนัด" : "ยกเลิกนัด"} title={confirmCancel ? "กดอีกครั้งเพื่อยืนยันยกเลิกนัด (ไม่ส่งข้อความถึงลูกค้า)" : "ยกเลิกนัด"}
            onClick={() => (confirmCancel ? cancel() : setConfirmCancel(true))}>
            <Icon name="x" />{confirmCancel && <span className="icon-btn-text">ยืนยัน</span>}
          </button>
        </div>
      )}
    </div>
  );
}

/** นัดที่ AI รับไว้และยังไม่ลงนัด กติกา "ลงนัดก่อน" อยู่ที่ booking_pending ของแชท นัดจริงอยู่ใน AppointmentsBlock */
export function BookingsBlock({ conversationId, contactName, bookings, blurred, onChanged, onReschedule, onError }: {
  conversationId: string;
  contactName: string | null;
  bookings: BookingCardRow[];
  blurred: boolean;
  onChanged: () => void;
  onReschedule: (id: string) => void;
  onError: (message: string) => void;
}) {
  const pending = bookings.filter((b) => b.status === "ai_confirmed");
  if (!pending.length) return null;
  return (
    <section className="side-block">
      <div className="side-head">
        <h3>นัดที่ AI รับไว้</h3>
        <span className="chip red tiny">ยังไม่ลงนัด</span>
      </div>
      <div className={blurred ? "sensitive-blur" : ""}>
        {pending.map((b) => (
          <BookingCard key={`${b.id}${b.date}${b.time}${b.status}`} booking={b} conversationId={conversationId} contactName={contactName}
            onError={onError} onReschedule={onReschedule} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}
