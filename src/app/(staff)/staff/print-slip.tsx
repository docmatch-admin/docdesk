"use client";

import { useMemo } from "react";
import { createPortal } from "react-dom";
import qrcode from "qrcode-generator";

// CSS ไม่มีชื่อขนาด A6 จึงระบุเป็นมิลลิเมตร
const PRINT_CSS = `@page { size: 105mm 148mm; margin: 8mm; }
@media print { html, body { background: #fff !important; } body > *:not(.print-slip) { display: none !important; } }`;

/** ใบแจ้งรหัสขนาด A6 สร้างในหน้าเดียวกัน รหัสจึงไม่ไปอยู่ใน URL หรือประวัติเบราว์เซอร์ QR มีแค่ลิงก์ login */
export function PrintSlip({ name, login, password }: { name: string; login: string; password: string }) {
  const url = `${window.location.origin}/login`;
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }, [url]);

  return createPortal(
    <div className="print-slip">
      <style>{PRINT_CSS}</style>
      <div className="brand big">Doc<span>Desk</span></div>
      <h2>ใบแจ้งรหัสเข้าใช้งาน</h2>
      <dl>
        <dt>ชื่อ</dt><dd>{name}</dd>
        <dt>ชื่อผู้ใช้</dt><dd><code>{login}</code></dd>
        <dt>รหัสชั่วคราว</dt><dd><code>{password}</code></dd>
      </dl>
      <div className="print-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="print-url">{url}</p>
      <p>เข้าสู่ระบบแล้วระบบจะให้ตั้งรหัสใหม่ทันที เปลี่ยนรหัสแล้วทำลายใบนี้</p>
    </div>,
    document.body,
  );
}
