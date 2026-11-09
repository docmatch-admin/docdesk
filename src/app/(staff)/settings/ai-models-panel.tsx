"use client";

import { useEffect, useState } from "react";
import { InfoTip } from "./info-tip";
import { MODEL_USE_LABEL, SOURCE_LABEL, type AiModelSettings, type ModelUse, type ResolvedModel } from "@/lib/ai-models-rules";

type Active = Record<ModelUse, ResolvedModel>;
const USES: ModelUse[] = ["draft", "translate", "embed"];

/** โมเดล AI: หน้าตั้งค่าเป็นแหล่งหลัก env เป็นค่าสำรองตอนยังไม่ได้ตั้ง แสดงค่าที่ใช้จริงต่องาน */
export function AiModelsPanel({ initial }: { initial?: { stored: AiModelSettings; active: Active } } = {}) {
  const [active, setActive] = useState<Active | null>(initial?.active ?? null);
  const [form, setForm] = useState({ chat: initial?.stored.chat ?? "", translate: initial?.stored.translate ?? "", embed: initial?.stored.embed ?? "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = (j: { stored: AiModelSettings; active: Active }) => {
    setActive(j.active);
    setForm({ chat: j.stored.chat ?? "", translate: j.stored.translate ?? "", embed: j.stored.embed ?? "" });
  };

  useEffect(() => {
    fetch("/api/ai-models").then(async (r) => {
      if (r.ok) apply(await r.json());
      else setMsg((await r.json().catch(() => ({}))).error ?? "อ่านค่าไม่สำเร็จ");
    }).catch(() => setMsg("อ่านค่าไม่สำเร็จ"));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await fetch("/api/ai-models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setMsg(j.error ?? "บันทึกไม่สำเร็จ");
    apply(j);
    setMsg("บันทึกแล้ว ✓ ใช้ทันที (เครื่องอื่นของระบบภายใน 1 นาที)");
  }

  return (
    <section className="card ai-models">
      <h3>🤖 โมเดล AI <InfoTip text="ค่าในหน้านี้ใช้ก่อนเสมอ ช่องที่ว่างจะใช้ env บน Vercel (OPENAI_CHAT_MODEL / OPENAI_EMBED_MODEL) ถ้าไม่มีใช้ค่าเริ่มต้นในโค้ด · เปลี่ยนโมเดล embedding ต้องสร้าง embedding ของคลังความรู้และตัวอย่างคำตอบใหม่ทั้งหมด" /></h3>
      <table className="line-usage-table ai-models-table">
        <thead><tr><th>งาน</th><th>ใช้อยู่ตอนนี้</th><th>มาจาก</th></tr></thead>
        <tbody>
          {USES.map((u) => (
            <tr key={u}>
              <td>{MODEL_USE_LABEL[u]}</td>
              <td><code>{active?.[u].model ?? "…"}</code></td>
              <td className="muted small">{active ? (active[u].inherited ? `ใช้โมเดลหลัก (${SOURCE_LABEL[active[u].source]})` : SOURCE_LABEL[active[u].source]) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="ai-models-form" onSubmit={save}>
        <label>โมเดลหลัก (แชท)
          <input value={form.chat} onChange={(e) => setForm({ ...form, chat: e.target.value })} placeholder="เช่น gpt-4o-mini" autoComplete="off" spellCheck={false} />
        </label>
        <label>โมเดลแปล (ว่าง = ใช้โมเดลหลัก)
          <input value={form.translate} onChange={(e) => setForm({ ...form, translate: e.target.value })} placeholder="ว่างไว้ได้" autoComplete="off" spellCheck={false} />
        </label>
        <label>โมเดล embedding
          <input value={form.embed} onChange={(e) => setForm({ ...form, embed: e.target.value })} placeholder="เช่น text-embedding-3-small" autoComplete="off" spellCheck={false} />
        </label>
        <div className="row">
          <button className="btn primary small" disabled={busy}>{busy ? "กำลังบันทึก…" : "บันทึกโมเดล"}</button>
        </div>
      </form>
      {msg && <div className="small" role="status">{msg}</div>}
    </section>
  );
}
