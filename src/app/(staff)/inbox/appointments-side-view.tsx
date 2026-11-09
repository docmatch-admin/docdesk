import { useState } from "react";
import { DELIVERY_LABEL, deliveryState, STATUS_LABEL, thaiShortDate, timeShort, type Appointment, type DeliveryState } from "@/lib/appointment-rules";
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
  printHref: (id: string) => string;
  /** ฟอร์มผูก HN / ทำนัด (แทรกใต้หัว) */
  children?: React.ReactNode;
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
        <button type="button" className="icon-btn appt-side-add" title="ทำนัดใหม่" aria-label="ทำนัดใหม่" aria-expanded={props.creating || picking} onClick={create}>
          <Icon name="plus" />
        </button>
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
      {ask && <ConfirmDialog ask={ask} onClose={() => setAsk(null)} />}
    </section>
  );
}
