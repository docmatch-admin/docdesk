"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cleanProviderName, filterProviders, type ProviderOption } from "@/lib/providers";

interface Item { name: string; label: string; today?: boolean; custom?: boolean }

/**
 * ช่อง "ผู้นัด": dropdown ค้นหาได้ ตัวเลือกแรก "— ไม่ระบุ —" (ค่าว่าง)
 * แพทย์ที่ตรวจคนไข้รายนี้วันนี้อยู่บนสุดพร้อมป้าย "ตรวจวันนี้" แต่ไม่เลือกให้
 * ชื่อที่ไม่อยู่ในรายการพิมพ์แล้วเลือก "ใช้ชื่อ …" ได้ (แพทย์ใหม่ที่ยังไม่มีใน visit)
 */
export function ProviderSelect({ value, options, onChange, label = "ผู้นัด", defaultOpen = false }: {
  value: string; options: ProviderOption[]; onChange: (v: string) => void; label?: string; /** ภาพตัวอย่าง/เทสต์ */ defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const btnId = useId();

  const typed = cleanProviderName(q);
  const found = filterProviders(options, q);
  const exact = found.some((o) => o.name.toLocaleLowerCase("th") === typed.toLocaleLowerCase("th"));
  const items: Item[] = [
    { name: "", label: "— ไม่ระบุ —" },
    ...found.map((o) => ({ name: o.name, label: o.name, today: o.today })),
    ...(typed && !exact ? [{ name: typed, label: `ใช้ชื่อ “${typed}”`, custom: true }] : []),
  ];
  const selected = options.find((o) => o.name === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    requestAnimationFrame(() => input.current?.focus());
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => { setHi(0); }, [q]);

  function pick(it: Item) {
    onChange(it.name);
    setOpen(false);
    setQ("");
    requestAnimationFrame(() => document.getElementById(btnId)?.focus());
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(items.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[hi]) pick(items[hi]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); setQ(""); document.getElementById(btnId)?.focus(); }
  }

  return (
    <div className="provider-select" ref={root}>
      <button id={btnId} type="button" className={`provider-select-btn ${value ? "" : "empty"}`} aria-haspopup="listbox" aria-expanded={open}
        aria-label={`${label}: ${value || "ไม่ระบุ"}`} onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }}>
        <span className="provider-select-value">{value || "— ไม่ระบุ —"}</span>
        {selected?.today && <span className="provider-today">ตรวจวันนี้</span>}
        <span className="provider-select-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="provider-select-pop">
          <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={`${listId}-${hi}`} aria-label={`ค้นหา${label}`} placeholder="พิมพ์ค้นชื่อแพทย์" value={q}
            onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} autoComplete="off" />
          <ul id={listId} role="listbox" aria-label={label} className="provider-select-list">
            {items.map((it, i) => (
              <li key={`${it.custom ? "+" : ""}${it.name}`} id={`${listId}-${i}`} role="option" aria-selected={it.name === value && !it.custom}
                className={`${i === hi ? "hi" : ""} ${it.name === "" ? "none" : ""} ${it.custom ? "custom" : ""}`}
                onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)}>
                <span className="provider-option-name">{it.label}</span>
                {it.today && <span className="provider-today">ตรวจวันนี้</span>}
              </li>
            ))}
            {found.length === 0 && !typed && <li className="provider-select-empty" aria-disabled="true">ยังไม่มีรายชื่อแพทย์จาก visit</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
