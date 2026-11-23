"use client";

import { useEffect } from "react";
import { deliveryState, DELIVERY_LABEL, thaiShortDate, timeShort, type Appointment } from "@/lib/appointment-rules";
import { Icon } from "../icons";
import type { SideGroup } from "./appointments-side-view";

/** แท็บห้องแชทบนมือถือ: แชท · ข้อมูลลูกค้า (= กล่องขวาของจอใหญ่ทั้งกล่อง ไม่แยกนัด/งาน/คอมเมนต์ซ้ำ) */
export type MobileTab = "chat" | "info";
export interface ApptSummary {
  count: number; next: Appointment | null; dates: string[];
  /** นัดที่สร้างล่าสุด (ทุกสถานะ) ใช้ซ่อนคำขอจองจากเว็บที่ทำนัดไปแล้ว แม้เลื่อนวัน/ยกเลิกภายหลัง */
  latestCreatedAt: string | null;
  /** คนไข้หลักที่ผูกกับแชทนี้ (ไม่มี = ยังไม่ผูก HN) ใช้ในหัวกล่องข้อมูลลูกค้า */
  patient?: { hn: string; name: string | null; phone: string | null; role: "patient" | "relative" } | null;
}

/** นัดที่ยังไม่ถึงของทุก HN ที่ผูกกับแชทนี้ · นัดถัดไป = ใกล้สุด */
export function summarize(groups: SideGroup[]): ApptSummary {
  const upcoming = groups.flatMap((g) => g.upcoming).filter((a) => !a.series_done && a.status !== "cancelled");
  upcoming.sort((a, b) => (a.appoint_date + a.time_start).localeCompare(b.appoint_date + b.time_start));
  const created = groups.flatMap((g) => [...g.upcoming, ...g.past]).map((a) => a.created_at ?? "").filter(Boolean).sort();
  // คนไข้หลัก: HN ที่ตั้งเป็นหลัก > ของตัวเอง > HN แรก
  const linked = groups.filter((g) => g.hn);
  const main = linked.find((g) => g.primary) ?? linked.find((g) => g.role === "patient") ?? linked[0];
  const patient = main?.hn ? { hn: main.hn, name: main.name, phone: main.phone ?? null, role: main.role } : null;
  return { count: upcoming.length, next: upcoming[0] ?? null, dates: [...new Set(upcoming.map((a) => a.appoint_date))], latestCreatedAt: created.at(-1) ?? null, patient };
}

export function MobileChatTabs({ tab, onTab, appointments, tasks, notes }: {
  tab: MobileTab; onTab: (t: MobileTab) => void; appointments: number; tasks: number; notes: number;
}) {
  // จุดแดง = มีงานค้างหรือคอมเมนต์ในข้อมูลลูกค้า · นัดแสดงในแถบนัดถัดไปอยู่แล้ว
  const alert = tasks > 0 || notes > 0;
  const hint = [appointments > 0 ? `นัด ${appointments}` : "", tasks > 0 ? `งาน ${tasks}` : "", notes > 0 ? `คอมเมนต์ ${notes}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="mtabs" role="tablist" aria-label="ส่วนของแชท">
      <button type="button" role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => onTab("chat")}>แชท</button>
      <button type="button" role="tab" aria-selected={tab === "info"} className={tab === "info" ? "on" : ""} onClick={() => onTab("info")}
        title={hint || undefined}>
        ข้อมูลลูกค้า{alert && <span className="mtab-dot" aria-label={hint} />}
      </button>
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
