"use client";

import { deliveryState, DELIVERY_LABEL, thaiShortDate, timeShort, type Appointment } from "@/lib/appointment-rules";
import { Icon } from "../icons";
import type { SideGroup } from "./appointments-side-view";

/** แท็บห้องแชทบนมือถือ (จอใหญ่ไม่แสดง ใช้กล่องขวาเหมือนเดิม) */
export type MobileTab = "chat" | "appt" | "tasks" | "notes" | "info";
export interface ApptSummary { count: number; next: Appointment | null }

/** นัดที่ยังไม่ถึงของทุก HN ที่ผูกกับแชทนี้ · นัดถัดไป = ใกล้สุด */
export function summarize(groups: SideGroup[]): ApptSummary {
  const upcoming = groups.flatMap((g) => g.upcoming).filter((a) => !a.series_done && a.status !== "cancelled");
  upcoming.sort((a, b) => (a.appoint_date + a.time_start).localeCompare(b.appoint_date + b.time_start));
  return { count: upcoming.length, next: upcoming[0] ?? null };
}

export function MobileChatTabs({ tab, onTab, appointments, tasks, notes }: {
  tab: MobileTab; onTab: (t: MobileTab) => void; appointments: number; tasks: number; notes: number;
}) {
  const items: [MobileTab, string, number, string?][] = [
    ["chat", "แชท", 0],
    ["appt", "นัด", appointments],
    ["tasks", "งาน", tasks],
    ["notes", "คอมเมนต์", notes, "note"],
    ["info", "ข้อมูลคนไข้", 0],
  ];
  return (
    <div className="mtabs" role="tablist" aria-label="ส่วนของแชท">
      {items.map(([k, label, n, kind]) => (
        <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => onTab(k)}>
          {label}
          {n > 0 && (kind === "note"
            ? <span className="mtab-badge note">{n}</span>
            : <span className="mtab-count"> · {n}</span>)}
        </button>
      ))}
    </div>
  );
}

const STRIP_STATE: Record<string, string> = { confirmed: "ok", reschedule: "warn", failed: "bad", no_chat: "bad" };

export function NextAppointmentStrip({ next, blurred, onOpen }: { next: Appointment; blurred: boolean; onOpen: () => void }) {
  const state = deliveryState(next);
  const label = state === "failed" || state === "no_chat" ? "ต้องโทร" : DELIVERY_LABEL[state];
  return (
    <button type="button" className={`next-appt ${blurred ? "sensitive-blur" : ""}`} onClick={onOpen} aria-label="ดูนัดของแชทนี้">
      <Icon name="calendar" size={20} />
      <span className="next-appt-text">
        <b>นัดถัดไป</b> {thaiShortDate(next.appoint_date).replace(/ \d{2}$/, "")} · {timeShort(next)}{next.purpose_text ? ` · ${next.purpose_text}` : ""}
      </span>
      {label && <span className={`next-appt-state ${STRIP_STATE[state] ?? ""}`}>{label}</span>}
    </button>
  );
}
