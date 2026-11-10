"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { InfoTip } from "./info-tip";

/**
 * หน้าตั้งค่า: ปุ่ม "บันทึกการตั้งค่า" ปุ่มเดียวบันทึกทุกหมวด
 * แต่ละกลุ่มลงทะเบียนสถานะ "มีการแก้ไขที่ยังไม่บันทึก" และฟังก์ชันบันทึกของตัวเองที่นี่
 * ทุกหมวดยังอยู่ใน DOM แม้เลือกหมวดอื่น ค่าที่แก้ไม่หายเมื่อสลับหมวด
 */
export type SettingsTab = "overview" | "ai" | "chat" | "appointments" | "team" | "display";

export interface SaveUnit {
  id: string;
  label: string;
  tab: SettingsTab;
  /** คืนข้อความ error หรือ null เมื่อสำเร็จ */
  save: () => Promise<string | null>;
}

export interface SettingsCtx {
  setUnit(unit: SaveUnit, dirty: boolean): void;
  removeUnit(id: string): void;
  /** สิ่งผิดปกติที่ต้องแสดงจุดแดงที่เมนูหมวด (สุขภาพระบบ, โควตา LINE ≥ 80%) */
  setAlert(key: string, tab: SettingsTab, on: boolean): void;
}

export const SettingsContext = createContext<SettingsCtx | null>(null);

/** ลงทะเบียนกลุ่มกับปุ่มบันทึกรวม */
export function useSaveUnit(id: string, label: string, tab: SettingsTab, dirty: boolean, save: () => Promise<string | null>) {
  const ctx = useContext(SettingsContext);
  const ref = useRef(save);
  ref.current = save;
  useEffect(() => {
    ctx?.setUnit({ id, label, tab, save: () => ref.current() }, dirty);
  }, [ctx, id, label, tab, dirty]);
  useEffect(() => () => ctx?.removeUnit(id), [ctx, id]);
}

export function useTabAlert(key: string, tab: SettingsTab, on: boolean) {
  const ctx = useContext(SettingsContext);
  useEffect(() => { ctx?.setAlert(key, tab, on); }, [ctx, key, tab, on]);
}

/** กลุ่มการตั้งค่า: หัวข้อกลุ่ม (ไม่มีอีโมจิ) · ป้ายชิดขวา · ⓘ → เส้นคั่นบาง → แถวตั้งค่า (ไม่มีกรอบการ์ด) */
export function SetGroup({ title, info, dirty, side, className, children }: {
  title: string; info?: string; dirty?: boolean; side?: React.ReactNode; className?: string; children?: React.ReactNode;
}) {
  return (
    <section className={`set-group2 ${className ?? ""}`}>
      <div className="set-group2-head">
        <h2>{title}</h2>
        <div className="set-group2-side">
          {dirty && <span className="dirty-badge" title="มีการแก้ไขที่ยังไม่บันทึก">ยังไม่บันทึก</span>}
          {side}
          {info && <InfoTip text={info} />}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * แถวตั้งค่า: ซ้าย = ชื่อ + คำอธิบายสั้น (~35%) · ขวา = ช่องกรอก/สวิตช์/ตาราง (~65%)
 * จอแคบกว่า 1024px ซ้อนบน-ล่าง · `full` = เนื้อหากว้างเต็มแถว (ตาราง) ชื่ออยู่บน
 */
export function SetLine({ label, desc, htmlFor, full, children }: {
  label: React.ReactNode; desc?: React.ReactNode; htmlFor?: string; full?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className={`set-line ${full ? "full" : ""}`}>
      <div className="set-line-label">
        {htmlFor ? <label htmlFor={htmlFor} className="set-line-name">{label}</label> : <div className="set-line-name">{label}</div>}
        {desc && <div className="set-line-desc">{desc}</div>}
      </div>
      <div className="set-line-control">{children}</div>
    </div>
  );
}

/** สวิตช์เปิด/ปิด (checkbox role=switch) */
export function Switch({ checked, onChange, label, disabled, id, hideLabel }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string; hideLabel?: boolean }) {
  return (
    <label className="switch">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      <span className={hideLabel ? "sr-only" : "switch-text"}>{label}</span>
    </label>
  );
}
