"use client";

import { useEffect, useState } from "react";
import { SetGroup, SetLine, useSaveUnit } from "./settings-save";
import { SOURCE_LABEL, type AiModelSettings, type ModelUse, type ResolvedModel } from "@/lib/ai-models-rules";

type Active = Record<ModelUse, ResolvedModel>;

/** โมเดล AI: หน้าตั้งค่าเป็นแหล่งหลัก env เป็นค่าสำรองตอนยังไม่ได้ตั้ง แสดงค่าที่ใช้จริงต่องาน */
export function AiModelsPanel({ initial }: { initial?: { stored: AiModelSettings; active: Active } } = {}) {
  const [active, setActive] = useState<Active | null>(initial?.active ?? null);
  const [form, setForm] = useState({ chat: initial?.stored.chat ?? "", translate: initial?.stored.translate ?? "", embed: initial?.stored.embed ?? "" });
  const [msg, setMsg] = useState("");
  // ค่าที่บันทึกล่าสุด เทียบกับฟอร์ม → มีการแก้ไขที่ยังไม่บันทึก
  const [stored, setStored] = useState(JSON.stringify(form));

  const apply = (j: { stored: AiModelSettings; active: Active }) => {
    setActive(j.active);
    const f = { chat: j.stored.chat ?? "", translate: j.stored.translate ?? "", embed: j.stored.embed ?? "" };
    setForm(f);
    setStored(JSON.stringify(f));
  };

  useEffect(() => {
    fetch("/api/ai-models").then(async (r) => {
      if (r.ok) apply(await r.json());
      else setMsg((await r.json().catch(() => ({}))).error ?? "อ่านค่าไม่สำเร็จ");
    }).catch(() => setMsg("อ่านค่าไม่สำเร็จ"));
  }, []);

  const dirty = JSON.stringify(form) !== stored;
  /** บันทึกผ่านปุ่ม "บันทึกการตั้งค่า" ของหน้า */
  async function save(): Promise<string | null> {
    const r = await fetch("/api/ai-models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(j.error ?? "บันทึกไม่สำเร็จ"); return j.error ?? "บันทึกไม่สำเร็จ"; }
    apply(j);
    setMsg("บันทึกแล้ว ✓ ใช้ทันที (เครื่องอื่นของระบบภายใน 1 นาที)");
    return null;
  }
  useSaveUnit("ai-models", "โมเดล AI", "ai", dirty, save);

  const using = (u: ModelUse) => (active ? `ใช้อยู่: ${active[u].model} (${active[u].inherited ? `ใช้โมเดลหลัก · ${SOURCE_LABEL[active[u].source]}` : SOURCE_LABEL[active[u].source]})` : "กำลังโหลด…");
  return (
    <SetGroup title="โมเดล AI" className="ai-models" dirty={dirty} info="ค่าในหน้านี้ใช้ก่อนเสมอ ช่องที่ว่างจะใช้ env บน Vercel (OPENAI_CHAT_MODEL / OPENAI_EMBED_MODEL) ถ้าไม่มีใช้ค่าเริ่มต้นในโค้ด · เปลี่ยนโมเดล embedding ต้องสร้าง embedding ของคลังความรู้และตัวอย่างคำตอบใหม่ทั้งหมด">
      <SetLine label="โมเดลหลัก (แชท)" desc="ใช้ร่างคำตอบและงานทั่วไป" htmlFor="model-chat">
        <input id="model-chat" value={form.chat} onChange={(e) => setForm({ ...form, chat: e.target.value })} placeholder="เช่น gpt-4o-mini" autoComplete="off" spellCheck={false} />
        <div className="set-line-hint">{using("draft")}</div>
      </SetLine>
      <SetLine label="โมเดลแปล" desc="ว่าง = ใช้โมเดลหลัก" htmlFor="model-translate">
        <input id="model-translate" value={form.translate} onChange={(e) => setForm({ ...form, translate: e.target.value })} placeholder="ว่างไว้ได้" autoComplete="off" spellCheck={false} />
        <div className="set-line-hint">{using("translate")}</div>
      </SetLine>
      <SetLine label="โมเดล embedding" desc="เปลี่ยนแล้วต้องสร้าง embedding ใหม่ทั้งหมด" htmlFor="model-embed">
        <input id="model-embed" value={form.embed} onChange={(e) => setForm({ ...form, embed: e.target.value })} placeholder="เช่น text-embedding-3-small" autoComplete="off" spellCheck={false} />
        <div className="set-line-hint">{using("embed")}</div>
      </SetLine>
      {msg && <div className="small" role="status">{msg}</div>}
    </SetGroup>
  );
}
