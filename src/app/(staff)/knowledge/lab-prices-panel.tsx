"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_B2B_RULES, normalizeB2bRules, type B2bRules } from "@/lib/lab-pricing";
import { supabaseBrowser } from "@/lib/supabase/browser";

interface ItemRow { code: string; name_en: string; name_th: string; category: string; cost: number | null; price: number | null; active: boolean }
interface PackageRow { code: string; name: string; cost: number | null; price: number; items_without_single_price: string[]; active: boolean }

const LOW_PROFIT = 20;
const toNumber = (v: string) => (v.trim() === "" ? null : Number(v));

/** หน้าแก้ราคาแล็บ เรียกผ่าน API ของ admin เพราะมีต้นทุน */
export function LabPricesPanel() {
  const sb = useMemo(() => supabaseBrowser(), []);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [packages, setPackages] = useState<PackageRow[]>([]);
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState("");
  const [form, setForm] = useState({ code: "", name_en: "", name_th: "", category: "", price: "", cost: "" });
  const [rules, setRules] = useState<B2bRules>(DEFAULT_B2B_RULES);

  const load = useCallback(async () => {
    const res = await fetch("/api/lab-prices");
    if (!res.ok) return setMsg("โหลดราคาไม่สำเร็จ");
    const j = await res.json();
    setItems(j.items);
    setPackages(j.packages);
  }, []);
  useEffect(() => {
    load();
    sb.from("settings").select("value").eq("key", "lab_b2b_rules").maybeSingle()
      .then(({ data }) => { if (data) setRules(normalizeB2bRules(data.value)); });
  }, [load, sb]);

  async function patch(kind: "item" | "package", code: string, body: Record<string, unknown>) {
    setMsg("");
    const res = await fetch("/api/lab-prices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, code, ...body }),
    });
    if (!res.ok) setMsg((await res.json().catch(() => ({}))).error ?? "บันทึกไม่สำเร็จ");
    load();
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const res = await fetch("/api/lab-prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, price: toNumber(form.price), cost: toNumber(form.cost) }),
    });
    if (!res.ok) return setMsg((await res.json().catch(() => ({}))).error ?? "เพิ่มไม่สำเร็จ");
    setForm({ code: "", name_en: "", name_th: "", category: "", price: "", cost: "" });
    load();
  }

  async function saveRules() {
    const { error } = await sb.from("settings").upsert({ key: "lab_b2b_rules", value: normalizeB2bRules(rules), updated_at: new Date().toISOString() });
    setMsg(error ? `บันทึกไม่สำเร็จ: ${error.message}` : "บันทึกเกณฑ์ B2B แล้ว");
  }

  const needle = q.trim().toLowerCase();
  const shown = items.filter((i) => !needle || `${i.code} ${i.name_en} ${i.name_th} ${i.category}`.toLowerCase().includes(needle));
  const profitOf = (price: number | null, cost: number | null) => (price == null || cost == null ? null : Number(price) - Number(cost));
  const lowProfit = items.filter((i) => { const p = profitOf(i.price, i.cost); return p !== null && p < LOW_PROFIT; });
  const noPrice = items.filter((i) => i.price == null).map((i) => i.name_en);
  const unpricedInPackages = [...new Set(packages.flatMap((p) => p.items_without_single_price))]
    .filter((name) => !items.some((i) => i.price != null && (i.code.toLowerCase() === name.toLowerCase() || i.name_en.toLowerCase() === name.toLowerCase())));
  const missing = [...new Set([...noPrice, ...unpricedInPackages])];

  return (
    <div className="lab-admin">
      {msg && <div className="small" role="status">{msg}</div>}
      <section className="card">
        <h3>ต้องดู</h3>
        <p className="small"><span className="lab-flag low">กำไรต่ำกว่า {LOW_PROFIT} บาท</span> {lowProfit.length ? lowProfit.map((i) => i.name_en).join(", ") : "ไม่มี"}</p>
        <p className="small"><span className="lab-flag none">ยังไม่มีราคาเดี่ยว</span> {missing.length ? missing.join(", ") : "ไม่มี"}</p>
      </section>

      <section className="card">
        <h3>แพ็กเกจ</h3>
        <div className="report-table-wrap">
          <table className="report-table lab-table">
            <thead><tr><th scope="col">แพ็กเกจ</th><th scope="col">ราคา</th><th scope="col">ทุน</th><th scope="col">กำไร</th><th scope="col">เปิดใช้</th></tr></thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.code} className={p.active ? "" : "lab-off"}>
                  <td>{p.name}</td>
                  <td><input key={`p${p.price}`} type="number" min={0} defaultValue={p.price} aria-label={`ราคา ${p.name}`} onBlur={(e) => {
                    const v = toNumber(e.target.value);
                    if (v !== null && v !== Number(p.price)) patch("package", p.code, { price: v });
                  }} /></td>
                  <td><input key={`c${p.cost}`} type="number" min={0} defaultValue={p.cost ?? ""} aria-label={`ทุน ${p.name}`} onBlur={(e) => {
                    const v = toNumber(e.target.value);
                    if (v !== (p.cost == null ? null : Number(p.cost))) patch("package", p.code, { cost: v });
                  }} /></td>
                  <td>{profitOf(p.price, p.cost) ?? "–"}</td>
                  <td><input type="checkbox" checked={p.active} aria-label={`เปิดใช้ ${p.name}`} onChange={(e) => patch("package", p.code, { active: e.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="row between">
          <h3>รายการเดี่ยว</h3>
          <input className="lab-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหารายการ…" aria-label="ค้นหารายการเดี่ยว" />
        </div>
        <div className="report-table-wrap">
          <table className="report-table lab-table">
            <thead><tr><th scope="col">รายการ</th><th scope="col">หมวด</th><th scope="col">ราคา</th><th scope="col">ทุน</th><th scope="col">กำไร</th><th scope="col">เปิดใช้</th></tr></thead>
            <tbody>
              {shown.map((i) => {
                const profit = profitOf(i.price, i.cost);
                const flag = i.price == null ? "lab-row-none" : profit !== null && profit < LOW_PROFIT ? "lab-row-low" : "";
                return (
                  <tr key={i.code} className={`${flag} ${i.active ? "" : "lab-off"}`}>
                    <td>{i.name_en} <span className="muted small">{i.name_th}</span></td>
                    <td className="small">{i.category}</td>
                    <td><input key={`p${i.price}`} type="number" min={0} defaultValue={i.price ?? ""} aria-label={`ราคา ${i.name_en}`} onBlur={(e) => {
                      const v = toNumber(e.target.value);
                      if (v !== (i.price == null ? null : Number(i.price))) patch("item", i.code, { price: v });
                    }} /></td>
                    <td><input key={`c${i.cost}`} type="number" min={0} defaultValue={i.cost ?? ""} aria-label={`ทุน ${i.name_en}`} onBlur={(e) => {
                      const v = toNumber(e.target.value);
                      if (v !== (i.cost == null ? null : Number(i.cost))) patch("item", i.code, { cost: v });
                    }} /></td>
                    <td>{profit ?? "–"}{flag === "lab-row-low" && " ⚠️"}{flag === "lab-row-none" && " ยังไม่มีราคา"}</td>
                    <td><input type="checkbox" checked={i.active} aria-label={`เปิดใช้ ${i.name_en}`} onChange={(e) => patch("item", i.code, { active: e.target.checked })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <form className="card form" onSubmit={add}>
        <h3>เพิ่มรายการ</h3>
        <div className="lab-form">
          <label>รหัส<input required value={form.code} placeholder="เช่น UA" onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <label>ชื่ออังกฤษ<input required value={form.name_en} onChange={(e) => setForm({ ...form, name_en: e.target.value })} /></label>
          <label>ชื่อไทย<input value={form.name_th} onChange={(e) => setForm({ ...form, name_th: e.target.value })} /></label>
          <label>หมวด<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></label>
          <label>ราคา (เว้นว่างได้)<input type="number" min={0} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
          <label>ทุน<input type="number" min={0} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></label>
        </div>
        <div className="row"><button className="btn primary small">เพิ่มรายการ</button></div>
      </form>

      <section className="card">
        <h3>เกณฑ์ใบเสนอราคา B2B</h3>
        {rules.tiers.map((t, i) => (
          <label key={i} className="inline">
            ตั้งแต่
            <input type="number" min={1} value={t.minStaff} aria-label={`จำนวนคนขั้นที่ ${i + 1}`} onChange={(e) => {
              const tiers = [...rules.tiers];
              tiers[i] = { ...t, minStaff: Number(e.target.value) };
              setRules({ ...rules, tiers });
            }} /> คน ลด
            <input type="number" min={0} max={99} value={t.percent} aria-label={`ส่วนลดขั้นที่ ${i + 1}`} onChange={(e) => {
              const tiers = [...rules.tiers];
              tiers[i] = { ...t, percent: Number(e.target.value) };
              setRules({ ...rules, tiers });
            }} /> %
          </label>
        ))}
        <label className="inline">กำไรขั้นต่ำต่อคน
          <input type="number" min={0} value={rules.minProfitPerPerson} onChange={(e) => setRules({ ...rules, minProfitPerPerson: Number(e.target.value) })} /> บาท
        </label>
        <div className="row"><button type="button" className="btn primary small" onClick={saveRules}>บันทึกเกณฑ์</button></div>
      </section>
    </div>
  );
}
