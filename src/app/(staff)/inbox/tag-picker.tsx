"use client";

import { useEffect, useRef, useState } from "react";
import { TAG_GROUP_LABEL, type Tag, type TagGroup } from "@/lib/tags";
import { TagChip } from "../tag-chip";

/** ปุ่ม "+ แท็ก": ค้นหาแท็กที่มี หรือสร้างใหม่ได้ทันที */
export function TagPicker({ tags, current, onPick, onCreate }: {
  tags: Tag[];
  current: string[];
  onPick: (name: string) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const query = q.trim();
  const matches = tags.filter((t) => t.active && !current.includes(t.name) && t.name.toLowerCase().includes(query.toLowerCase()));
  const exists = tags.some((t) => t.name === query);
  const finish = () => { setOpen(false); setQ(""); };

  function pick(name: string) { onPick(name); finish(); }
  function create() { if (query && !exists) { onCreate(query); finish(); } }

  return (
    <div className="tag-picker" ref={root}>
      <button className="btn ghost small" onClick={() => setOpen(!open)} aria-expanded={open}>+ แท็ก</button>
      {open && (
        <div className="tag-pop">
          <input autoFocus value={q} maxLength={40} placeholder="ค้นหา หรือพิมพ์แท็กใหม่…" aria-label="ค้นหาแท็ก"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") finish();
              if (e.key === "Enter") { e.preventDefault(); if (matches[0]) pick(matches[0].name); else create(); }
            }} />
          <div className="tag-pop-list">
            {(Object.keys(TAG_GROUP_LABEL) as TagGroup[]).map((g) => {
              const inGroup = matches.filter((t) => t.group === g);
              if (!inGroup.length) return null;
              return (
                <div key={g}>
                  <div className="muted small tag-pop-group">{TAG_GROUP_LABEL[g]}</div>
                  {inGroup.map((t) => (
                    <button key={t.id} className="tag-pop-item" onClick={() => pick(t.name)}>
                      <TagChip name={t.name} color={t.color} />
                    </button>
                  ))}
                </div>
              );
            })}
            {query && !exists && (
              <button className="tag-pop-item" onClick={create}>+ สร้างแท็ก “{query}”</button>
            )}
            {!matches.length && !query && <div className="muted small tag-pop-group">ติดแท็กครบแล้ว</div>}
          </div>
        </div>
      )}
    </div>
  );
}
