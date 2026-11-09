"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { InfoTip } from "./info-tip";

/**
 * หน้าตั้งค่า: ปุ่ม "บันทึกการตั้งค่า" ปุ่มเดียวบันทึกทุกการ์ด
 * แต่ละการ์ดลงทะเบียนสถานะ "มีการแก้ไขที่ยังไม่บันทึก" และฟังก์ชันบันทึกของตัวเองที่นี่
 * การ์ดยังอยู่ใน DOM แม้อยู่แท็บอื่น ค่าที่แก้ไม่หายเมื่อสลับแท็บ
 */
export type SettingsTab = "overview" | "ai" | "chat" | "appointments" | "team";

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
  /** สิ่งผิดปกติที่ต้องแสดงจุดแดงที่แท็บ (สุขภาพระบบ, โควตา LINE ≥ 80%) */
  setAlert(key: string, tab: SettingsTab, on: boolean): void;
}

export const SettingsContext = createContext<SettingsCtx | null>(null);

/** ลงทะเบียนการ์ดกับปุ่มบันทึกรวม */
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

/** หัวการ์ดแบบเดียวกันทุกใบ: หัวข้อ (ไม่มีอีโมจิ) · ป้าย/สถานะชิดขวา · ⓘ คำอธิบาย → เส้นบาง */
export function CardHead({ title, info, dirty, children }: { title: string; info?: string; dirty?: boolean; children?: React.ReactNode }) {
  return (
    <div className="card-head">
      <h3>{title}</h3>
      <div className="card-head-side">
        {dirty && <span className="dirty-badge" title="มีการแก้ไขที่ยังไม่บันทึก">ยังไม่บันทึก</span>}
        {children}
        {info && <InfoTip text={info} />}
      </div>
    </div>
  );
}
