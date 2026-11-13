"use client";

import { useMemo, useState } from "react";
import { bangkokToday, thaiShortDate } from "@/lib/appointment-rules";
import { parseWebBookingRequest, type WebBookingRequest } from "@/lib/web-booking";
import type { Message } from "@/lib/types";
import { AppointmentForm, deliveryText, EMPTY_DRAFT } from "../appointments/appointment-form";
import { Icon } from "../icons";

/**
 * ลูกค้าจองคิวผ่านฟอร์มบนเว็บ (ส่งเป็นข้อความ LINE): แสดงคำขอในกล่องนัดของแชท ให้เจ้าหน้าที่ตรวจแล้วกดยืนยันลงนัด
 * ซ่อนเมื่อมีนัดวันนั้นแล้ว หรือคำขอเป็นวันที่ผ่านไปแล้ว
 */
export function WebBookingCard({ messages, conversationId, bookedDates, blurred, onSaved, onError }: {
  messages: Message[];
  conversationId: string;
  bookedDates: string[];
  blurred: boolean;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const today = bangkokToday();
  const req = useMemo<WebBookingRequest | null>(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.direction !== "in") continue;
      const r = parseWebBookingRequest(m.body_th || m.body);
      if (r) return r;
    }
    return null;
  }, [messages]);
  if (!req || (req.date && (req.date < today || bookedDates.includes(req.date))) || saved === conversationId) return null;

  return (
    <section className="side-block tp-appt web-booking">
      <div className="side-head"><b>คำขอจองจากเว็บ</b><span className="chip orange tiny">รอยืนยัน</span></div>
      <div className={`booking-card pending ${blurred ? "sensitive-blur" : ""}`}>
        <div className="booking-title">{req.service}{req.date ? ` · ${thaiShortDate(req.date)}` : ""}{req.time ? ` ${req.time} น.` : ""}</div>
        <div className="booking-sub">{req.name || "ไม่มีชื่อ"} · {req.phone || "ไม่มีเบอร์"}{req.time ? "" : " · ยังไม่ระบุเวลา"}</div>
        {open ? (
          <AppointmentForm compact conversationId={conversationId} saveLabel="บันทึกเป็นนัด"
            initial={{
              ...EMPTY_DRAFT,
              patient_name: req.name ?? "",
              phone: req.phone ?? "",
              appoint_date: req.date ?? "",
              ...(req.time ? { time_mode: "exact" as const, time_start: req.time } : {}),
              purpose_text: req.service,
            }}
            onCancel={() => setOpen(false)}
            onSaved={(r) => { setOpen(false); setSaved(conversationId); onError(`ลงนัดแล้ว · ${deliveryText(r.delivery)}`); onSaved(); }} />
        ) : (
          <div className="icon-row">
            <button type="button" className="btn primary small" onClick={() => setOpen(true)}>
              <Icon name="check" /> ยืนยันลงนัด
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
