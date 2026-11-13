"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { localToday, thaiDate, thaiTime, thaiWeekday } from "@/lib/booking-rules";
import { contactName, type ContactNameFields } from "@/lib/patient-name";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { AppointmentForm, deliveryText } from "../appointments/appointment-form";
import { bookingDraft } from "../inbox/booking-card";
import { Icon } from "../icons";

interface Row {
  id: string;
  conversation_id: string;
  service: string;
  date: string;
  time: string;
  name: string | null;
  phone: string | null;
  status: "ai_confirmed" | "recorded" | "cancelled";
  conversations: { contacts: ContactNameFields | null } | null;
}

const SECTIONS: { status: Row["status"]; title: string }[] = [
  { status: "ai_confirmed", title: "📅 ยังไม่ลงนัด" },
  { status: "recorded", title: "ลงนัดแล้ว" },
  { status: "cancelled", title: "ยกเลิก" },
];

export function BookingsClient() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<Row[]>([]);
  // ยืนยันลงนัด: เปิดฟอร์มนัดใต้แถว (ข้อมูลจาก AI แก้ได้ก่อนบันทึก)
  const [converting, setConverting] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await sb.from("bookings")
      .select('id, conversation_id, service, "date", "time", name, phone, status, conversations(contacts(display_name, platform_name, hn, patient_full_name, patient_relation, name_locked))')
      .order("date").order("time").limit(1000);
    setRows((data ?? []) as unknown as Row[]);
  }, [sb]);

  useEffect(() => {
    load();
    const ch = sb.channel("bookings-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, load)
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [sb, load]);

  const today = localToday(Date.now(), "Asia/Bangkok");
  const tomorrow = localToday(Date.now() + 86_400_000, "Asia/Bangkok");

  return (
    <div className="page">
      <div className="page-toolbar">
        <Link className="btn ghost" href="/appointments"><span aria-hidden="true">←</span> นัดหมาย</Link>
        <h1>นัดที่ AI รับไว้</h1>
      </div>
      {flash && <div className="banner ok" role="status">{flash}</div>}
      {SECTIONS.map(({ status, title }) => {
        const list = rows.filter((r) => r.status === status);
        return (
          <section key={status} className="card">
            <h3>{title} ({list.length})</h3>
            {list.length === 0 && <div className="muted small">ไม่มีรายการ</div>}
            {list.length > 0 && (
              <div className="report-table-wrap">
                <table className="report-table booking-table">
                  <thead><tr><th scope="col">วันนัด</th><th scope="col">เวลา</th><th scope="col">บริการ</th><th scope="col">ชื่อ</th><th scope="col">เบอร์</th><th scope="col">แชท</th>{status === "ai_confirmed" && <th scope="col"><span className="sr-only">ยืนยัน</span></th>}</tr></thead>
                  <tbody>
                    {list.map((r) => {
                      const soon = r.status !== "cancelled" && (r.date === today || r.date === tomorrow);
                      const shownName = r.conversations?.contacts?.hn ? contactName(r.conversations.contacts) : r.name || contactName(r.conversations?.contacts, "–");
                      return (
                        <Fragment key={r.id}>
                        <tr className={`${status === "ai_confirmed" ? "booking-unrecorded" : ""} ${soon ? "booking-soon" : ""}`}>
                          <td>
                            วัน{thaiWeekday(r.date)}ที่ {thaiDate(r.date)}
                            {soon && <span className="chip booking-when">{r.date === today ? "วันนี้" : "พรุ่งนี้"}</span>}
                          </td>
                          <td>{thaiTime(r.time)} น.</td>
                          <td>{r.service}</td>
                          <td>{shownName}</td>
                          <td>{r.phone || "–"}</td>
                          <td><Link href={`/inbox?c=${r.conversation_id}`}>เปิดแชท</Link></td>
                          {status === "ai_confirmed" && (
                            <td>
                              <button type="button" className="btn primary small" disabled={converting === r.id}
                                onClick={() => { setFlash(null); setConverting(r.id); }}><Icon name="check" /> ยืนยันลงนัด</button>
                            </td>
                          )}
                        </tr>
                        {converting === r.id && (
                          <tr className="booking-convert-row">
                            <td colSpan={7}>
                              <AppointmentForm compact conversationId={r.conversation_id} bookingId={r.id} saveLabel="บันทึกเป็นนัด"
                                initial={bookingDraft(r, shownName === "–" ? null : shownName, today)}
                                onCancel={() => setConverting(null)}
                                onSaved={(res) => { setConverting(null); setFlash(`ลงนัด ${shownName} แล้ว · ${deliveryText(res.delivery)}`); load(); }} />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
