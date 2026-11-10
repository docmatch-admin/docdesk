"use client";

import { useEffect, useRef, useState } from "react";

/**
 * รายการแบบแถวกะทัดรัดของหน้าตั้งค่า (แท็ก, เหตุผลนัด, กฎติดแท็ก):
 * หัวกลุ่มอยู่เหนือรายการ · แถวสูง 48px คั่นเส้นบาง · [⋮⋮ ลาก] [เนื้อหา] …… [สวิตช์] [⋯]
 */
/** columns = หัวคอลัมน์ชิดขวา · aligned = หัวคอลัมน์เรียงตรงกับช่องในแถว (ใช้คลาส c-*) */
export function ListSection({ title, count, unit, columns, aligned, children }: {
  title?: string; count?: number; unit?: string; columns?: React.ReactNode; aligned?: boolean; children: React.ReactNode;
}) {
  return (
    <div className="slist-group">
      {(title || columns) && (
        <div className="slist-head">
          {title && <b className="slist-title">{title}</b>}
          {count != null && <span className="slist-count">{count} {unit}</span>}
          {columns && <span className={`slist-cols ${aligned ? "aligned" : ""}`}>{columns}</span>}
        </div>
      )}
      <div className="slist" role="list">{children}</div>
    </div>
  );
}

/**
 * ลากเรียงด้วย handle ⋮⋮ · คีย์บอร์ด: โฟกัสที่ handle แล้วกด ↑/↓
 * แถวใช้ key คงที่ (id) โฟกัสจึงตามแถวไปหลังย้าย
 */
export function useDragSort(count: number, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const end = () => { setDrag(null); setOver(null); };
  return {
    announce,
    row: (i: number) => ({
      onDragOver: (e: React.DragEvent) => { if (drag === null) return; e.preventDefault(); if (over !== i) setOver(i); },
      onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag !== null && drag !== i) onMove(drag, i); end(); },
      "data-dragging": drag === i || undefined,
      "data-over": (over === i && drag !== null && drag !== i) || undefined,
    }),
    handle: (i: number, name: string) => ({
      type: "button" as const,
      draggable: true,
      className: "drag-handle",
      "aria-label": `${name} ลำดับที่ ${i + 1} จาก ${count} · ลากหรือกด ↑/↓ เพื่อเรียงลำดับ`,
      title: "ลากเพื่อเรียงลำดับ (หรือกด ↑/↓)",
      onDragStart: (e: React.DragEvent) => {
        setDrag(i);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(i));
        const row = (e.currentTarget as HTMLElement).closest(".slist-row");
        if (row) e.dataTransfer.setDragImage(row, 20, 24);
      },
      onDragEnd: end,
      onKeyDown: (e: React.KeyboardEvent) => {
        const to = e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : -1;
        if (to < 0 || to >= count) return;
        e.preventDefault();
        onMove(i, to);
        setAnnounce(`ย้าย ${name} ไปลำดับที่ ${to + 1}`);
      },
    }),
  };
}

/** handle ⋮⋮ */
export function DragHandle(props: ReturnType<ReturnType<typeof useDragSort>["handle"]>) {
  return <button {...props}><span aria-hidden="true">⋮⋮</span></button>;
}

export interface RowMenuItem { label: string; danger?: boolean; /** ข้อความยืนยันก่อนทำ (ไม่ใช้ window.confirm) */ confirm?: string; onSelect: () => void | Promise<void> }

/** เมนู ⋯ ท้ายแถว · รายการที่มี confirm ถามซ้ำในเมนูเอง */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<RowMenuItem | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setOpen(false); setAsking(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); setAsking(null); } };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const run = async (it: RowMenuItem) => {
    if (it.confirm && asking !== it) return setAsking(it);
    setOpen(false);
    setAsking(null);
    await it.onSelect();
  };
  return (
    <div className="row-menu" ref={root}>
      <button type="button" className="row-menu-btn" aria-label={`ตัวเลือกของ ${label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(!open); setAsking(null); }}>⋯</button>
      {open && (
        <div className="row-menu-pop" role="menu">
          {asking ? (
            <div className="row-menu-confirm">
              <span>{asking.confirm}</span>
              <div className="row">
                <button type="button" className="btn small danger-solid" onClick={() => run(asking)}>{asking.label}</button>
                <button type="button" className="btn ghost small" onClick={() => setAsking(null)}>ยกเลิก</button>
              </div>
            </div>
          ) : items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? "danger" : ""} onClick={() => run(it)}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
