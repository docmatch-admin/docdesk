"use client";

import { channelLabel } from "@/lib/push-rules";
import { LANGUAGE_NAME } from "@/lib/translate-names";
import type { Conversation } from "@/lib/types";
import { Icon } from "../icons";
import type { ApptSummary } from "./mobile-chat";

/**
 * หัวกล่อง "ข้อมูลลูกค้า": ชื่อ · HN · เบอร์ · ช่องทาง · ภาษา
 * แสดงเฉพาะข้อมูลที่มีจริง (ยังไม่ผูก HN = ไม่มีบรรทัด HN/เบอร์) ไม่เดา ไม่โชว์ช่องว่าง
 * ข้อมูลคนไข้เห็นเฉพาะเจ้าหน้าที่ ไม่ส่งให้ AI
 */
export function CustomerCard({ conversation: c, patient, facts, blurred }: {
  conversation: Conversation;
  patient: ApptSummary["patient"];
  /** จากการมาตรวจครั้งล่าสุดใน iService (ไม่มี = ไม่แสดง) */
  facts?: { rights: string | null; age: number | null };
  blurred: boolean;
}) {
  const ct = c.contacts;
  const hn = patient?.hn ?? ct?.hn ?? null;
  const name = patient?.name || ct?.patient_full_name || ct?.display_name || "ลูกค้า";
  const platformName = ct?.platform_name || ct?.display_name || null;
  const phone = (patient?.phone ?? "").replace(/\D/g, "");
  const lang = ct?.language && ct.language !== "th" ? (LANGUAGE_NAME[ct.language] ?? ct.language) : null;
  const relative = patient?.role === "relative";
  return (
    <div className={`cust-card ${blurred ? "sensitive-blur" : ""}`}>
      <div className="cust-head">
        {ct?.avatar_url
          ? <img className="avatar cust-avatar" src={ct.avatar_url} alt="" />
          : <span className="avatar cust-avatar" aria-hidden="true">{name.trim().charAt(0) || "?"}</span>}
        <div className="cust-name">
          <b className={name.length > 18 ? "long" : undefined} title={name}>{name}</b>
          {hn && <span className="muted small">HN {hn}{facts?.age != null && ` · ${facts.age} ปี`}{relative && " · ญาติ/คนดูแล"}</span>}
        </div>
      </div>
      <dl className="cust-grid">
        {hn && facts?.rights && (<><dt>สิทธิ</dt><dd><span className="rights-chip">{facts.rights}</span></dd></>)}
        {phone && (<><dt>เบอร์โทร</dt><dd><a href={`tel:${phone}`}><Icon name="phone" size={14} /> {formatPhone(phone)}</a></dd></>)}
        <dt>ช่องทาง</dt>
        <dd className="cust-channel">
          <span className={`ch-tag ${c.channels?.type ?? ""}`}>{channelLabel(c.channels?.type)}</span>
          {platformName && platformName !== name && <span className="one">{platformName}</span>}
        </dd>
        {lang && (<><dt>ภาษา</dt><dd>{lang} (ระบบแปลให้)</dd></>)}
      </dl>
    </div>
  );
}

function formatPhone(d: string) {
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  return d;
}
