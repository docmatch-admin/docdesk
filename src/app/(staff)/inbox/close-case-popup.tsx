"use client";

import { useEffect, useRef } from "react";
import type { Tag } from "@/lib/tags";
import { TagChip } from "../tag-chip";

/** กดชิปหรือข้าม = เสร็จแล้วทันที ไม่มีขั้นตอนยืนยันซ้ำ */
export function CloseCasePopup({ tags, current, hasDraft, onChoose, onCancel }: {
  tags: Tag[];
  current: string[];
  hasDraft: boolean;
  onChoose: (tag?: string) => void;
  onCancel: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouse = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) onCancel(); };
    // ใช้ e.code เพราะ e.key เปลี่ยนตามแป้นพิมพ์ไทย/อังกฤษ
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") { e.preventDefault(); onCancel(); return; }
      const digit = /^Digit([1-9])$/.exec(e.code);
      const tag = digit && !e.ctrlKey && !e.metaKey && !e.altKey ? tags[Number(digit[1]) - 1] : undefined;
      if (tag) { e.preventDefault(); onChoose(tag.name); }
    };
    document.addEventListener("mousedown", onMouse);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      window.removeEventListener("keydown", onKey);
    };
  }, [tags, onChoose, onCancel]);

  return (
    <div className="close-pop" ref={root} role="dialog" aria-label="เสร็จแล้ว">
      <div className="small"><b>เสร็จแล้ว</b> <span className="muted">เลือกสถานะ หรือข้าม</span></div>
      <div className="close-pop-tags">
        {tags.map((t, i) => (
          <button key={t.id} className={`close-pop-tag ${current.includes(t.name) ? "on" : ""}`} onClick={() => onChoose(t.name)}>
            <span className="muted small">{i + 1}</span>
            <TagChip name={t.name} color={t.color} />
          </button>
        ))}
      </div>
      {hasDraft && <div className="close-pop-warn small">ข้อความหรือรูปที่เตรียมส่งไว้จะหายไป</div>}
      <div className="row between">
        <span className="muted small">Esc ยกเลิก</span>
        <button autoFocus className="btn ghost small" onClick={() => onChoose()}>ข้าม</button>
      </div>
    </div>
  );
}
