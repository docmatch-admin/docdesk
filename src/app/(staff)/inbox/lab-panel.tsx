"use client";

import { useEffect, useMemo, useState } from "react";
import {
  buildPriceMessage, compareSelection, packageValue,
  type B2bQuote, type LabItem, type LabPackage,
} from "@/lib/lab-pricing";
import { supabaseBrowser } from "@/lib/supabase/browser";

const baht = (n: number) => Math.round(n).toLocaleString("th-TH");
type CostMap = { items: Map<string, number | null>; packages: Map<string, number | null> };

/** แผงราคาแล็บในห้องแชท: agent ได้ข้อมูลที่ไม่มีต้นทุน ส่วน admin ดึงต้นทุนเพิ่มผ่าน API */
export function LabPanel({ isAdmin, onInsert, onClose }: { isAdmin: boolean; onInsert: (text: string) => void; onClose: () => void }) {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [items, setItems] = useState<LabItem[]>([]);
  const [packages, setPackages] = useState<LabPackage[]>([]);
  const [costs, setCosts] = useState<CostMap>({ items: new Map(), packages: new Map() });
  const [q, setQ] = useState("");
  const [pickedItems, setPickedItems] = useState<string[]>([]);
  const [pickedPackages, setPickedPackages] = useState<string[]>([]);
  const [tab, setTab] = useState<"price" | "b2b">("price");
  const [b2bCode, setB2bCode] = useState("");
  const [b2bCount, setB2bCount] = useState(30);
  const [quote, setQuote] = useState<{ quote: B2bQuote; message: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    sb.from("lab_items").select("code, name_en, name_th, price, category, active").eq("active", true).order("category").order("name_en")
      .then(({ data }) => setItems((data ?? []) as LabItem[]));
    sb.from("lab_packages").select("code, name, price, includes, compare_item_codes, items_without_single_price, active").eq("active", true).order("price")
      .then(({ data }) => setPackages((data ?? []) as LabPackage[]));
    if (!isAdmin) return;
    fetch("/api/lab-prices").then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j) return;
      setCosts({
        items: new Map(j.items.map((i: { code: string; cost: number | null }) => [i.code, i.cost])),
        packages: new Map(j.packages.map((p: { code: string; cost: number | null }) => [p.code, p.cost])),
      });
    });
  }, [sb, isAdmin]);

  const needle = q.trim().toLowerCase();
  const matches = (s: string) => !needle || s.toLowerCase().includes(needle);
  const shownPackages = packages.filter((p) => matches(`${p.name} ${p.includes.join(" ")}`));
  const shownItems = items.filter((i) => matches(`${i.name_en} ${i.name_th} ${i.code}`));

  const comparison = useMemo(() => compareSelection(pickedItems, [], items, packages), [pickedItems, items, packages]);
  const selectedValues = useMemo(
    () => packages.filter((p) => pickedPackages.includes(p.code)).map((p) => packageValue(p, items)),
    [packages, pickedPackages, items],
  );
  const toggle = (list: string[], set: (v: string[]) => void, code: string) =>
    set(list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);

  const costOfItems = pickedItems.reduce((n, c) => n + Number(costs.items.get(c) ?? 0), 0);
  const message = buildPriceMessage(comparison, selectedValues);
  const profit = (price: number | null, cost: number | null | undefined) =>
    price == null || cost == null ? "–" : baht(Number(price) - Number(cost));

  async function runQuote() {
    setError("");
    setQuote(null);
    const res = await fetch("/api/lab-prices/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: b2bCode, count: b2bCount }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return setError(j.error ?? "คำนวณไม่สำเร็จ");
    setQuote(j);
  }

  return (
    <div className="lab-panel" role="dialog" aria-label="ราคาแล็บ">
      <div className="row between">
        <div className="tabs wide lab-tabs">
          <button className={tab === "price" ? "on" : ""} onClick={() => setTab("price")}>💰 ราคาแล็บ</button>
          {isAdmin && <button className={tab === "b2b" ? "on" : ""} onClick={() => setTab("b2b")}>ใบเสนอราคา B2B</button>}
        </div>
        <button className="btn ghost small" onClick={onClose}>ปิด</button>
      </div>

      {tab === "price" ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหารายการหรือแพ็กเกจ…" aria-label="ค้นหาราคาแล็บ" />
          <div className="lab-list">
            {shownPackages.map((p) => {
              const v = packageValue(p, items);
              return (
                <label key={p.code} className="lab-row">
                  <input type="checkbox" checked={pickedPackages.includes(p.code)} onChange={() => toggle(pickedPackages, setPickedPackages, p.code)} />
                  <span className="grow"><b>{p.name}</b>
                    {v.savingAtLeast > 0 && <span className="muted small"> · ประหยัดอย่างน้อย {baht(v.savingAtLeast)}</span>}
                  </span>
                  <b>{baht(v.price)}</b>
                  {isAdmin && <span className="muted small lab-cost">ทุน {costs.packages.get(p.code) ?? "–"} · กำไร {profit(v.price, costs.packages.get(p.code))}</span>}
                </label>
              );
            })}
            {shownItems.map((i) => (
              <label key={i.code} className="lab-row">
                <input type="checkbox" checked={pickedItems.includes(i.code)} onChange={() => toggle(pickedItems, setPickedItems, i.code)} />
                <span className="grow">{i.name_en} <span className="muted small">{i.name_th}</span></span>
                <span>{i.price == null ? "ยังไม่มีราคา" : baht(Number(i.price))}</span>
                {isAdmin && <span className="muted small lab-cost">ทุน {costs.items.get(i.code) ?? "–"} · กำไร {profit(i.price, costs.items.get(i.code))}</span>}
              </label>
            ))}
            {!shownPackages.length && !shownItems.length && <div className="muted small">ไม่พบรายการ</div>}
          </div>

          {(pickedItems.length > 0 || pickedPackages.length > 0) && (
            <div className="lab-summary">
              {pickedItems.length > 0 && (
                <>
                  <div>ซื้อแยกรวม <b>{baht(comparison.singlesTotal)} บาท</b>
                    {isAdmin && <span className="muted small"> · ทุน {baht(costOfItems)} · กำไร {baht(comparison.singlesTotal - costOfItems)}</span>}
                  </div>
                  {comparison.covering.length === 0 && <div className="muted small">ไม่มีแพ็กเกจที่ครอบคลุมครบทุกรายการ</div>}
                  {comparison.covering.slice(0, 3).map((p) => (
                    <div key={p.code} className="small">
                      {p.name} {baht(p.price)} บาท
                      {p.price < comparison.singlesTotal
                        ? <b> ถูกกว่า {baht(comparison.singlesTotal - p.price)} บาท</b>
                        : <span className="muted"> ไม่ถูกกว่าซื้อแยก</span>}
                    </div>
                  ))}
                  {comparison.recommendation === "package" && <div className="small muted">ตรวจว่าลูกค้าตรงกลุ่มของแพ็กเกจก่อนเสนอ</div>}
                </>
              )}
              <button className="btn primary small" disabled={!message} onClick={() => { onInsert(message); onClose(); }}>ใส่ในช่องพิมพ์</button>
            </div>
          )}
        </>
      ) : (
        <div className="lab-b2b">
          <label>แพ็กเกจ
            <select value={b2bCode} onChange={(e) => setB2bCode(e.target.value)}>
              <option value="">เลือกแพ็กเกจ</option>
              {packages.map((p) => <option key={p.code} value={p.code}>{p.name} ({baht(Number(p.price))} บาท)</option>)}
            </select>
          </label>
          <label>จำนวนพนักงาน
            <input type="number" min={1} value={b2bCount} onChange={(e) => setB2bCount(Number(e.target.value))} />
          </label>
          <button className="btn primary small" disabled={!b2bCode} onClick={runQuote}>คำนวณ</button>
          {error && <div className="error small" role="alert">{error}</div>}
          {quote && (
            <div className="lab-summary">
              <div>ท่านละ <b>{baht(quote.quote.unitPrice)} บาท</b> (ลด {quote.quote.appliedPercent}%) รวม <b>{baht(quote.quote.total)} บาท</b></div>
              <div className="small">กำไรต่อคน {baht(quote.quote.unitProfit)} บาท · กำไรรวม <b>{baht(quote.quote.totalProfit)} บาท</b></div>
              {quote.quote.limitedByMinProfit && !quote.quote.belowMinAtList && <div className="small warn-text">ส่วนลดตามขั้น {quote.quote.tierPercent}% ถูกจำกัดเพื่อรักษากำไรขั้นต่ำต่อคน</div>}
              {quote.quote.belowMinAtList && <div className="small warn-text">ราคาปกติมีกำไรต่ำกว่าขั้นต่ำอยู่แล้ว จึงไม่ลดราคา</div>}
              <button className="btn primary small" onClick={() => { onInsert(quote.message); onClose(); }}>ใส่ในช่องพิมพ์</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
