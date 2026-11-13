"use client";

import { useEffect } from "react";
import { deliveryState, DELIVERY_LABEL, thaiShortDate, timeShort, type Appointment } from "@/lib/appointment-rules";
import { Icon } from "../icons";
import type { SideGroup } from "./appointments-side-view";

/** แท็บห้องแชทบนมือถือ (จอใหญ่ไม่แสดง ใช้กล่องขวาเหมือนเดิม) */
export type MobileTab = "chat" | "appt" | "tasks" | "notes";
export interface ApptSummary { count: number; next: Appointment | null; dates: string[] }

/** นัดที่ยังไม่ถึงของทุก HN ที่ผูกกับแชทนี้ · นัดถัดไป = ใกล้สุด */
export function summarize(groups: SideGroup[]): ApptSummary {
  const upcoming = groups.flatMap((g) => g.upcoming).filter((a) => !a.series_done && a.status !== "cancelled");
  upcoming.sort((a, b) => (a.appoint_date + a.time_start).localeCompare(b.appoint_date + b.time_start));
  return { count: upcoming.length, next: upcoming[0] ?? null, dates: [...new Set(upcoming.map((a) => a.appoint_date))] };
}

export function MobileChatTabs({ tab, onTab, appointments, tasks, notes }: {
  tab: MobileTab; onTab: (t: MobileTab) => void; appointments: number; tasks: number; notes: number;
}) {
  const items: [MobileTab, string, number, string?][] = [
    ["chat", "แชท", 0],
    ["appt", "นัด", appointments],
    ["tasks", "งาน", tasks],
    ["notes", "คอมเมนต์", notes, "note"],
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

/**
 * มือถือ: ตอนพิมพ์ (คีย์บอร์ดขึ้น) ล็อกหน้าแชทให้พอดีพื้นที่ที่เห็นจริง (visualViewport) และซ่อนส่วนเสริม
 * <html data-typing> + --app-h / --vv-top ใช้ใน CSS · iOS ไม่ย่อหน้าเว็บเองเวลาคีย์บอร์ดขึ้น จึงต้องคำนวณเอง
 */
export function useMobileTyping(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const vv = window.visualViewport;
    const mq = window.matchMedia("(max-width: 899px)");
    const typing = () => {
      const el = document.activeElement;
      return mq.matches && !!el && el.closest(".composer") !== null && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
    };
    const update = () => {
      if (vv) {
        root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
        root.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
      }
      root.toggleAttribute("data-typing", typing());
    };
    // focusout เกิดก่อน focus ไปที่อื่น รอให้ activeElement เปลี่ยนก่อน
    const later = () => setTimeout(update, 0);
    update();
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
      root.removeAttribute("data-typing");
      root.style.removeProperty("--app-h");
      root.style.removeProperty("--vv-top");
    };
  }, [active]);
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
