"use client";

import { channelLabel } from "@/lib/push-rules";
import { LANGUAGE_NAME } from "@/lib/translate-names";
import type { Conversation } from "@/lib/types";
import { Icon } from "../icons";
import type { ApptSummary } from "./mobile-chat";

/**
 * กล่อง "ข้อมูลลูกค้า" ตามแบบ (คอม: ชื่อ → แท็ก + แชทลับ → ตารางข้อมูล · มือถือ: ชื่อ + แท็ก + สิทธิ → ปุ่มโทร/ทำนัด → ผู้ติดต่อ)
 * แสดงเฉพาะข้อมูลที่มีจริง ไม่เดา ไม่โชว์ช่องว่าง · ข้อมูลคนไข้เห็นเฉพาะเจ้าหน้าที่ ไม่ส่งให้ AI
 */
export function CustomerCard({ conversation: c, patient, facts, blurred, tags, lockSwitch, onNewAppointment }: {
  conversation: Conversation;
  patient: ApptSummary["patient"];
  /** จากการมาตรวจครั้งล่าสุดใน iService (ไม่มี = ไม่แสดง) */
  facts?: { rights: string | null; age: number | null };
  blurred: boolean;
  /** แท็ก + ปุ่มเพิ่มแท็ก */
  tags?: React.ReactNode;
  /** สวิตช์แชทลับ (คอม) */
  lockSwitch?: React.ReactNode;
  onNewAppointment?: () => void;
}) {
  const ct = c.contacts;
  const hn = patient?.hn ?? ct?.hn ?? null;
  const name = patient?.name || ct?.patient_full_name || ct?.display_name || "ลูกค้า";
  const platformName = ct?.platform_name || ct?.display_name || null;
  const phone = (patient?.phone ?? "").replace(/\D/g, "");
  const lang = ct?.language && ct.language !== "th" ? (LANGUAGE_NAME[ct.language] ?? ct.language) : null;
  const relative = patient?.role === "relative";
  // ผู้ติดต่อ = คนที่คุยในแชท เมื่อไม่ใช่คนไข้เอง
  const contact = relative && platformName && platformName !== name ? `${platformName} (ญาติ/คนดูแล)` : null;
  const rights = hn && facts?.rights ? facts.rights : null;
  const sub = [hn ? `HN ${hn}` : null, hn && facts?.age != null ? `${facts.age} ปี` : null, lang ? `ภาษา${lang}` : null].filter(Boolean).join(" · ");
  const ch = c.channels?.type ?? "";
  return (
    <div className={`cust-card ${blurred ? "sensitive-blur" : ""}`}>
      <div className="cust-head">
        {ct?.avatar_url
          ? <img className="avatar cust-avatar" src={ct.avatar_url} alt="" />
          : <span className="avatar cust-avatar" aria-hidden="true">{name.trim().charAt(0) || "?"}</span>}
        <div className="cust-name">
          <b className={name.length > 18 ? "long" : undefined} title={name}>{name}</b>
          {sub && <span className="cust-sub">{sub}</span>}
          {tags && <div className="cust-tags m-only">{tags}</div>}
        </div>
        {rights && <span className="rights-chip m-only">{rights}</span>}
      </div>

      {(tags || lockSwitch) && <div className="cust-tagrow d-only"><div className="cust-tags">{tags}</div>{lockSwitch}</div>}

      <dl className="cust-grid d-only">
        {rights && (<><dt>สิทธิ</dt><dd><span className="rights-chip">{rights}</span></dd></>)}
        {contact && (<><dt>ผู้ติดต่อ</dt><dd className="one">{contact}</dd></>)}
        {phone && (<><dt>เบอร์โทร</dt><dd><a href={`tel:${phone}`}>{formatPhone(phone)}</a></dd></>)}
        <dt>ช่องทาง</dt>
        <dd className="cust-channel">
          <span className={`ch-tag ${ch}`}>{channelLabel(c.channels?.type)}</span>
          {platformName && <span className="one">{platformName}</span>}
          {hn && <span className="cust-ok" title="เชื่อมกับคนไข้แล้ว">✓</span>}
        </dd>
      </dl>

      {(phone || onNewAppointment) && (
        <div className="cust-actions m-only">
          {phone && <a className="cust-call" href={`tel:${phone}`}><Icon name="phone" size={16} />โทร {formatPhone(phone)}</a>}
          {onNewAppointment && <button type="button" className="cust-appt" onClick={onNewAppointment}>ทำนัด</button>}
        </div>
      )}
      <div className="cust-contact m-only">
        {contact && <>ผู้ติดต่อ: <span>{contact}</span> · </>}
        <span className={hn ? "ok" : undefined}>{channelLabel(c.channels?.type)}{hn ? " เชื่อมแล้ว ✓" : ""}</span>
      </div>
    </div>
  );
}

function formatPhone(d: string) {
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  return d;
}
