"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { localToday, thaiDate, thaiTime, thaiWeekday } from "@/lib/booking-rules";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface Row {
  id: string;
  conversation_id: string;
  service: string;
  date: string;
  time: string;
  name: string | null;
  phone: string | null;
  status: "ai_confirmed" | "recorded" | "cancelled";
  conversations: { contacts: { display_name: string | null } | null } | null;
}

const SECTIONS: { status: Row["status"]; title: string }[] = [
  { status: "ai_confirmed", title: "📅 ยังไม่ลงนัด" },
  { status: "recorded", title: "ลงนัดแล้ว" },
  { status: "cancelled", title: "ยกเลิก" },
];

export function BookingsClient() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    const { data } = await sb.from("bookings")
      .select('id, conversation_id, service, "date", "time", name, phone, status, conversations(contacts(display_name))')
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
      <h1>นัดหมาย</h1>
      {SECTIONS.map(({ status, title }) => {
        const list = rows.filter((r) => r.status === status);
        return (
          <section key={status} className="card">
            <h3>{title} ({list.length})</h3>
            {list.length === 0 && <div className="muted small">ไม่มีรายการ</div>}
            {list.length > 0 && (
              <div className="report-table-wrap">
                <table className="report-table booking-table">
                  <thead><tr><th scope="col">วันนัด</th><th scope="col">เวลา</th><th scope="col">บริการ</th><th scope="col">ชื่อ</th><th scope="col">เบอร์</th><th scope="col">แชท</th></tr></thead>
                  <tbody>
                    {list.map((r) => {
                      const soon = r.status !== "cancelled" && (r.date === today || r.date === tomorrow);
                      return (
                        <tr key={r.id} className={`${status === "ai_confirmed" ? "booking-unrecorded" : ""} ${soon ? "booking-soon" : ""}`}>
                          <td>
                            วัน{thaiWeekday(r.date)}ที่ {thaiDate(r.date)}
                            {soon && <span className="chip booking-when">{r.date === today ? "วันนี้" : "พรุ่งนี้"}</span>}
                          </td>
                          <td>{thaiTime(r.time)} น.</td>
                          <td>{r.service}</td>
                          <td>{r.name || r.conversations?.contacts?.display_name || "–"}</td>
                          <td>{r.phone || "–"}</td>
                          <td><Link href={`/inbox?c=${r.conversation_id}`}>เปิดแชท</Link></td>
                        </tr>
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
