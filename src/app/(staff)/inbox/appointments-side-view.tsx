import { useState } from "react";
import { DELIVERY_LABEL, deliveryState, STATUS_LABEL, thaiShortDate, timeShort, type Appointment, type DeliveryState } from "@/lib/appointment-rules";
import { fullHn } from "@/lib/appointment-slip";
import { Icon } from "../icons";
import type { LinkedAccountRow } from "../appointments/linked-accounts";

/**
 * ส่วน "นัดครั้งต่อไป" ในกล่องขวาของแชท (แถบแคบ ~280–400px) แสดงผลอย่างเดียว ข้อมูลและการเรียก API อยู่ที่ AppointmentsBlock
 * หัวข้อไม่ตัดทีละพยางค์ บัญชีที่รับแจ้งเตือนบรรทัดเดียวต่อบัญชี นัดใกล้สุดก่อน นัดที่ผ่านแล้วย่อไว้
 */
export interface SideViewProps {
  isAdmin: boolean;
  link: { hn: string } | null;
  accounts: LinkedAccountRow[];
  upcoming: Appointment[];
  past: Appointment[];
  blurred?: boolean;
  creating: boolean;
  onCreate: () => void;
  onLinkHn?: () => void;
  onUnlink: () => void;
  onRelation: (a: LinkedAccountRow, relation: "patient" | "relative") => void;
  onDetach: (a: LinkedAccountRow) => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  printHref: (id: string) => string;
  /** ฟอร์มผูก HN / ทำนัด (แทรกใต้หัว) */
  children?: React.ReactNode;
}

const STATE_CLASS: Partial<Record<DeliveryState, string>> = {
  sent: "sent", confirmed: "confirmed", reschedule: "reschedule", failed: "call", no_chat: "call",
};
const CHANNEL_SHORT: Record<string, string> = { line: "LINE", facebook: "FB", instagram: "IG", web: "เว็บ" };

function stateOf(a: Appointment): { label: string; cls: string } {
  const s = deliveryState(a);
  if (s === "closed") return { label: STATUS_LABEL[a.status], cls: a.status === "cancelled" ? "cancelled" : "closed" };
  return { label: DELIVERY_LABEL[s] || STATUS_LABEL[a.status], cls: STATE_CLASS[s] ?? "" };
}

function ConfirmDialog({ text, yes, onYes, onClose }: { text: string; yes: string; onYes: () => void; onClose: () => void }) {
  return (
    <div className="mini-dialog-overlay" onClick={onClose}>
      <div className="mini-dialog" role="alertdialog" aria-modal="true" aria-label={text} onClick={(e) => e.stopPropagation()}>
        <p>{text}</p>
        <div className="row">
          <button type="button" className="btn danger-solid small" onClick={() => { onYes(); onClose(); }}>{yes}</button>
          <button type="button" className="btn ghost small" onClick={onClose} autoFocus>ยกเลิก</button>
        </div>
      </div>
    </div>
  );
}

function Card({ a, past, props }: { a: Appointment; past?: boolean; props: SideViewProps }) {
  const st = stateOf(a);
  return (
    <div className={`appt-side-card ${past ? "past" : ""}`}>
      <div className="appt-side-when">{thaiShortDate(a.appoint_date)} · {timeShort(a)} น.</div>
      <div className="appt-side-meta">
        <span className="appt-side-purpose">{a.purpose_text || "ไม่ระบุเหตุผล"}</span>
        <span className={`appt-side-state ${st.cls}`}>{st.label}</span>
        {past && <button type="button" className="link-btn appt-side-past-open" onClick={() => props.onOpen(a.id)}>ดู</button>}
        </div>
      {!past && (
        <div className="appt-side-actions">
          <button type="button" className="btn ghost small appt-side-detail" onClick={() => props.onOpen(a.id)}>รายละเอียด</button>
          <a className="icon-btn" href={props.printHref(a.id)} title="พิมพ์ใบนัด" aria-label="พิมพ์ใบนัด"><Icon name="printer" /></a>
          <button type="button" className="icon-btn" title="แก้ไขนัด" aria-label="แก้ไขนัด" onClick={() => props.onEdit(a.id)}><Icon name="pencil" /></button>
        </div>
      )}
    </div>
  );
}

export function AppointmentsSideView(props: SideViewProps) {
  const { isAdmin, link, accounts, upcoming, past } = props;
  const [ask, setAsk] = useState<{ text: string; yes: string; run: () => void } | null>(null);
  const following = accounts.filter((a) => a.following).length;

  return (
    <section className="side-block appt-side">
      <div className="appt-side-head">
        <h3 className="appt-side-title">นัดครั้งต่อไป</h3>
        <button type="button" className="icon-btn appt-side-add" title="ทำนัดใหม่" aria-label="ทำนัดใหม่" aria-expanded={props.creating} onClick={props.onCreate}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="appt-side-sub">
        {link ? (
          <>
            <span className="chip tiny appt-side-hn">HN {fullHn(link.hn)}</span>
            <span className="appt-side-dot">·</span><span>ผูกแล้ว</span>
            {isAdmin && (
              <>
                <span className="appt-side-dot">·</span>
                <button type="button" className="link-btn danger-link" onClick={() => setAsk({
                  text: `ยกเลิกการผูกแชทนี้กับ HN ${fullHn(link.hn)}? ชื่อแชทกลับเป็นชื่อเดิม และนัดของ HN นี้จะไม่ส่งเข้าแชทนี้`,
                  yes: "ยกเลิกผูก", run: props.onUnlink,
                })}>ยกเลิกผูก</button>
              </>
            )}
          </>
        ) : isAdmin && props.onLinkHn ? (
          <><span>ยังไม่ผูก HN</span><span className="appt-side-dot">·</span><button type="button" className="link-btn" onClick={props.onLinkHn}>ผูก HN</button></>
        ) : <span>ยังไม่ผูก HN</span>}
      </div>

      {accounts.length > 0 && (
        <ul className="appt-side-accounts" title={`บัญชีที่รับแจ้งเตือน ${accounts.length} บัญชี (ยังติดตาม ${following})`} aria-label={`บัญชีที่รับแจ้งเตือน ${accounts.length} บัญชี`}>
          {accounts.map((a) => (
            <li key={a.conversation_id} className={a.following ? "" : "off"} title={a.following ? undefined : "เลิกติดตาม LINE แล้ว ไม่ได้รับแจ้งเตือน"}>
              <span className={`ch-icon ch-${a.channel ?? "none"}`} aria-label={a.channel ?? ""}>{CHANNEL_SHORT[a.channel ?? ""] ?? "?"}</span>
              <span className="appt-side-acc-name">{a.name || "ไม่มีชื่อบัญชี"}</span>
              {isAdmin ? (
                <select className="appt-side-rel" aria-label={`ป้ายของ ${a.name ?? "บัญชี"}`} value={a.relation}
                  onChange={(e) => props.onRelation(a, e.target.value as "patient" | "relative")}>
                  <option value="patient">คนไข้</option>
                  <option value="relative">ญาติ</option>
                </select>
              ) : <span className="appt-side-rel-text">{a.relation === "relative" ? "ญาติ" : "คนไข้"}</span>}
              {isAdmin && (
                <button type="button" className="icon-btn ghost-icon" title="ยกเลิกการผูกบัญชีนี้" aria-label={`ยกเลิกการผูก ${a.name ?? "บัญชี"}`}
                  onClick={() => setAsk({ text: `ยกเลิกการผูกบัญชี ${a.name ?? ""}? บัญชีนี้จะไม่ได้รับข้อความนัดอีก`, yes: "ยกเลิกผูก", run: () => props.onDetach(a) })}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {props.children}

      <div className={`appt-side-list ${props.blurred ? "sensitive-blur" : ""}`}>
        {upcoming.length === 0 && !props.creating && <div className="muted small">ยังไม่มีนัด</div>}
        {upcoming.map((a) => <Card key={a.id} a={a} props={props} />)}
        {past.length > 0 && (
          <details className="appt-side-past">
            <summary>ดูนัดที่ผ่านมา ({past.length})</summary>
            {past.map((a) => <Card key={a.id} a={a} past props={props} />)}
          </details>
        )}
      </div>
      {ask && <ConfirmDialog text={ask.text} yes={ask.yes} onYes={ask.run} onClose={() => setAsk(null)} />}
    </section>
  );
}
