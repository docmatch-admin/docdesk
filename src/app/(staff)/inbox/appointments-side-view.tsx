import { useState } from "react";
import { bangkokToday, DELIVERY_LABEL, deliveryState, STATUS_LABEL, thaiShortDate, timeShort, type Appointment, type DeliveryState } from "@/lib/appointment-rules";
import { fullHn } from "@/lib/appointment-slip";
import { Icon } from "../icons";
import type { LinkedAccountRow } from "../appointments/linked-accounts";

/**
 * ส่วน "นัดครั้งต่อไป" ในกล่องขวาของแชท (แถบแคบ ~280–400px) แสดงผลอย่างเดียว ข้อมูลและการเรียก API อยู่ที่ AppointmentsBlock
 * บัญชีเดียวผูกได้หลาย HN: แยกกลุ่มตามคนไข้ ป้าย "ของตัวเอง"/"ญาติ" ปุ่ม + เลือกได้ว่าทำนัดให้ใคร
 * หัวข้อไม่ตัดทีละพยางค์ บัญชีที่รับแจ้งเตือนบรรทัดเดียวต่อบัญชี นัดใกล้สุดก่อน นัดที่ผ่านแล้วย่อไว้
 */
export interface SideGroup {
  /** null = นัดของแชทนี้ที่ยังไม่มี HN ที่ผูก */
  hn: string | null;
  name: string | null;
  phone?: string | null;
  role: "patient" | "relative";
  primary: boolean;
  accounts: LinkedAccountRow[];
  upcoming: Appointment[];
  past: Appointment[];
}

export interface SideViewProps {
  isAdmin: boolean;
  groups: SideGroup[];
  blurred?: boolean;
  creating: boolean;
  onCreate: (hn: string | null) => void;
  onLinkHn?: () => void;
  onUnlink: (hn: string) => void;
  onPrimary?: (hn: string) => void;
  onRelation: (a: LinkedAccountRow, relation: "patient" | "relative", hn: string) => void;
  onDetach: (a: LinkedAccountRow, hn: string) => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  /** เปิดรายละเอียดนัดที่หน้ายกเลิก (เลือกเหตุผลก่อนยกเลิกจริง) */
  onCancel: (id: string) => void;
  /** ฟอร์มผูก HN / ทำนัด (แทรกใต้หัว) */
  children?: React.ReactNode;
  /** ท้ายส่วนนัด (ผลแล็บล่าสุด) */
  footer?: React.ReactNode;
}

const STATE_CLASS: Partial<Record<DeliveryState, string>> = {
  sent: "sent", confirmed: "confirmed", reschedule: "reschedule", failed: "call", no_chat: "call",
};
const CHANNEL_SHORT: Record<string, string> = { line: "LINE", facebook: "FB", instagram: "IG", web: "เว็บ" };
const ROLE_LABEL = { patient: "ของตัวเอง", relative: "ญาติ" } as const;

function stateOf(a: Appointment): { label: string; cls: string } {
  const s = deliveryState(a);
  if (s === "closed") return { label: STATUS_LABEL[a.status], cls: a.status === "cancelled" ? "cancelled" : "closed" };
  return { label: DELIVERY_LABEL[s] || STATUS_LABEL[a.status], cls: STATE_CLASS[s] ?? "" };
}

type Ask = { text: string; yes: string; run: () => void };

function ConfirmDialog({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  return (
    <div className="mini-dialog-overlay" onClick={onClose}>
      <div className="mini-dialog" role="alertdialog" aria-modal="true" aria-label={ask.text} onClick={(e) => e.stopPropagation()}>
        <p>{ask.text}</p>
        <div className="row">
          <button type="button" className="btn danger-solid small" onClick={() => { ask.run(); onClose(); }}>{ask.yes}</button>
          <button type="button" className="btn ghost small" onClick={onClose} autoFocus>ยกเลิก</button>
        </div>
      </div>
    </div>
  );
}

const DOW = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const dayDiff = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${bangkokToday()}T00:00:00Z`)) / 86_400_000);
const inDays = (n: number) => (n === 0 ? "วันนี้" : n === 1 ? "พรุ่งนี้" : n > 1 ? `อีก ${n} วัน` : `${-n} วันที่แล้ว`);
const sentAt = (iso: string) => {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("th-TH", { day: "numeric", month: "short", timeZone: "Asia/Bangkok" }).format(d);
  const t = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Bangkok" }).format(d);
  return `${day} ${t}`;
};

/** การ์ดนัด (ตามแบบ): กล่องวันที่ซ้าย · เหตุผลตัวหนา · เวลา · แพทย์ · อีกกี่วัน · สถานะ · ปุ่มเลื่อน/ยกเลิก กดการ์ด = ดูรายละเอียด (พิมพ์ใบนัดอยู่ในนั้น) */
function Card({ a, past, props }: { a: Appointment; past?: boolean; props: SideViewProps }) {
  const st = stateOf(a);
  if (past) {
    return (
      <div className="appt-side-card past">
        <div className="appt-side-when">{thaiShortDate(a.appoint_date)} · {timeShort(a)} น.</div>
        <div className="appt-side-meta">
          <span className="appt-side-purpose">{a.purpose_text || "ไม่ระบุเหตุผล"}</span>
          <span className={`appt-side-state ${st.cls}`}>{st.label}</span>
          <button type="button" className="link-btn appt-side-past-open" onClick={() => props.onOpen(a.id)}>ดู</button>
        </div>
      </div>
    );
  }
  const d = new Date(`${a.appoint_date}T12:00:00+07:00`);
  const live = a.status !== "cancelled" && a.status !== "attended" && a.status !== "no_show";
  return (
    <div className="appt-card" role="button" tabIndex={0} aria-label={`ดูรายละเอียดนัด ${a.purpose_text ?? ""}`}
      onClick={() => props.onOpen(a.id)} onKeyDown={(e) => { if (e.key === "Enter") props.onOpen(a.id); }}>
      <div className="appt-card-top">
        <div className="appt-date" aria-hidden="true">
          <span>{DOW[d.getUTCDay()]}</span><b>{Number(a.appoint_date.slice(8, 10))}</b><span>{MON[Number(a.appoint_date.slice(5, 7)) - 1]}</span>
        </div>
        <div className="appt-card-main">
          <span className="appt-card-title">{a.purpose_text || "ไม่ระบุเหตุผล"}</span>
          <span className="appt-card-time">{timeShort(a)} น.{a.provider ? ` · ${a.provider}` : ""}</span>
          <span className="appt-card-in">{inDays(dayDiff(a.appoint_date))}</span>
        </div>
      </div>
      <div className="appt-card-chips">
        <span className={`appt-side-state ${st.cls}`}>{st.cls === "confirmed" ? "ยืนยันแล้ว ✓" : st.label}</span>
        {a.reminder_sent_at && <span className="appt-card-chip">เตือนทาง LINE {sentAt(a.reminder_sent_at)}</span>}
      </div>
      {live && (
        <div className="appt-card-actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="appt-card-btn" onClick={() => props.onEdit(a.id)}>เลื่อนนัด</button>
          <button type="button" className="appt-card-btn danger" onClick={() => props.onCancel(a.id)}>ยกเลิกนัด</button>
        </div>
      )}
    </div>
  );
}

function Group({ g, props, setAsk, showHead }: { g: SideGroup; props: SideViewProps; setAsk: (a: Ask) => void; showHead: boolean }) {
  const { isAdmin } = props;
  const hn = g.hn;
  const following = g.accounts.filter((a) => a.following).length;
  return (
    <div className="appt-side-group">
      {showHead && (
        <div className="appt-side-group-head">
          <span className="appt-side-group-name">{hn ? g.name || "ไม่มีชื่อ" : "นัดที่ยังไม่ผูก HN"}</span>
          {hn && <span className={`appt-side-role ${g.role}`}>{ROLE_LABEL[g.role]}</span>}
          {hn && g.primary && <span className="appt-side-role main" title="ใช้ตั้งชื่อแชท">หลัก</span>}
        </div>
      )}
      {hn && (
        <div className="appt-side-sub">
          <span className="chip tiny appt-side-hn">HN {fullHn(hn)}</span>
          <span className="appt-side-dot">·</span><span>ผูกแล้ว</span>
          {isAdmin && props.onPrimary && g.role === "patient" && !g.primary && (
            <><span className="appt-side-dot">·</span><button type="button" className="link-btn" onClick={() => props.onPrimary!(hn)}>ตั้งเป็นหลัก</button></>
          )}
          {isAdmin && (
            <>
              <span className="appt-side-dot">·</span>
              <button type="button" className="link-btn danger-link" onClick={() => setAsk({
                text: `ยกเลิกการผูกแชทนี้กับ HN ${fullHn(hn)}${g.name ? ` (${g.name})` : ""}? นัดของ HN นี้จะไม่ส่งเข้าแชทนี้ HN อื่นของแชทนี้ไม่กระทบ`,
                yes: "ยกเลิกผูก", run: () => props.onUnlink(hn),
              })}>ยกเลิกผูก</button>
            </>
          )}
        </div>
      )}
      {hn && g.accounts.length > 0 && (
        <ul className="appt-side-accounts" title={`บัญชีที่รับแจ้งเตือนของ HN นี้ ${g.accounts.length} บัญชี (ยังติดตาม ${following})`} aria-label={`บัญชีที่รับแจ้งเตือน ${g.accounts.length} บัญชี`}>
          {g.accounts.map((a) => (
            <li key={a.conversation_id} className={a.following ? "" : "off"} title={a.following ? undefined : "เลิกติดตาม LINE แล้ว ไม่ได้รับแจ้งเตือน"}>
              <span className={`ch-icon ch-${a.channel ?? "none"}`} aria-label={a.channel ?? ""}>{CHANNEL_SHORT[a.channel ?? ""] ?? "?"}</span>
              <span className="appt-side-acc-name">{a.name || "ไม่มีชื่อบัญชี"}</span>
              {isAdmin ? (
                <select className="appt-side-rel" aria-label={`ป้ายของ ${a.name ?? "บัญชี"}`} value={a.relation}
                  onChange={(e) => props.onRelation(a, e.target.value as "patient" | "relative", hn)}>
                  <option value="patient">คนไข้</option>
                  <option value="relative">ญาติ</option>
                </select>
              ) : <span className="appt-side-rel-text">{a.relation === "relative" ? "ญาติ" : "คนไข้"}</span>}
              {isAdmin && (
                <button type="button" className="icon-btn ghost-icon" title="ยกเลิกการผูกบัญชีนี้กับ HN นี้" aria-label={`ยกเลิกการผูก ${a.name ?? "บัญชี"}`}
                  onClick={() => setAsk({ text: `ยกเลิกการผูกบัญชี ${a.name ?? ""} กับ HN ${fullHn(hn)}? บัญชีนี้จะไม่ได้รับข้อความนัดของ HN นี้อีก`, yes: "ยกเลิกผูก", run: () => props.onDetach(a, hn) })}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className={`appt-side-list ${props.blurred ? "sensitive-blur" : ""}`}>
        {g.upcoming.length === 0 && <div className="muted small">ยังไม่มีนัด</div>}
        {g.upcoming.map((a) => <Card key={a.id} a={a} props={props} />)}
        {g.past.length > 0 && (
          <details className="appt-side-past">
            <summary>ดูนัดที่ผ่านมา ({g.past.length})</summary>
            {g.past.map((a) => <Card key={a.id} a={a} past props={props} />)}
          </details>
        )}
      </div>
    </div>
  );
}

export function AppointmentsSideView(props: SideViewProps) {
  const { isAdmin, groups } = props;
  const [ask, setAsk] = useState<Ask | null>(null);
  const [picking, setPicking] = useState(false);
  const linked = groups.filter((g) => g.hn);
  const many = linked.length > 1;

  function create() {
    // ผูกหลาย HN: เลือกว่าทำนัดให้ใคร
    if (many && !props.creating) return setPicking(!picking);
    setPicking(false);
    props.onCreate(linked[0]?.hn ?? null);
  }

  return (
    <section className="side-block appt-side">
      <div className="appt-side-head">
        <h3 className="appt-side-title">นัดครั้งต่อไป</h3>
        <button type="button" className="link-btn appt-side-add" aria-expanded={props.creating || picking} onClick={create}>+ ทำนัดใหม่</button>
      </div>
      {picking && (
        <div className="appt-side-pick" role="menu" aria-label="ทำนัดให้">
          <span className="small muted">ทำนัดให้</span>
          {linked.map((g) => (
            <button key={g.hn} type="button" role="menuitem" className="btn ghost small" onClick={() => { setPicking(false); props.onCreate(g.hn); }}>
              {g.name || `HN ${fullHn(g.hn!)}`} <span className={`appt-side-role ${g.role}`}>{ROLE_LABEL[g.role]}</span>
            </button>
          ))}
          <button type="button" role="menuitem" className="btn ghost small" onClick={() => { setPicking(false); props.onCreate(null); }}>คนอื่น (กรอกเอง)</button>
        </div>
      )}
      {!linked.length && (
        <div className="appt-side-sub">
          <span>ยังไม่ผูก HN</span>
          {isAdmin && props.onLinkHn && <><span className="appt-side-dot">·</span><button type="button" className="link-btn" onClick={props.onLinkHn}>ผูก HN</button></>}
        </div>
      )}
      {linked.length > 0 && isAdmin && props.onLinkHn && many && (
        <div className="appt-side-sub"><span>ผูก {linked.length} HN</span><span className="appt-side-dot">·</span><button type="button" className="link-btn" onClick={props.onLinkHn}>ผูก HN เพิ่ม</button></div>
      )}

      {props.children}

      {groups.map((g) => <Group key={g.hn ?? "none"} g={g} props={props} setAsk={setAsk} showHead={many || !g.hn || g.role === "relative"} />)}
      {!groups.length && !props.creating && <div className="muted small">ยังไม่มีนัด</div>}
      {linked.length === 1 && isAdmin && props.onLinkHn && (
        <button type="button" className="link-btn appt-side-more" onClick={props.onLinkHn}>+ ผูก HN เพิ่ม (ญาติ/คนที่ดูแล)</button>
      )}
      {props.footer}
      {ask && <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />}
    </section>
  );
}
