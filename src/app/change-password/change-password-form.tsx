"use client";

import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/staff-login";
import { SignOut } from "../(staff)/sign-out";

export function ChangePasswordForm({ name }: { name: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setErr("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
    setBusy(true);
    setErr("");
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) return window.location.assign("/inbox");
    setBusy(false);
    setErr((await res.json().catch(() => ({}))).error ?? "เปลี่ยนรหัสไม่สำเร็จ");
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="card login-card">
        <div className="brand big">Doc<span>Desk</span></div>
        <b>ตั้งรหัสผ่านใหม่</b>
        <p className="muted small">สวัสดี {name} กรุณาเปลี่ยนรหัสชั่วคราวก่อนเริ่มใช้งาน รหัสใหม่ต้องยาวอย่างน้อย {MIN_PASSWORD_LENGTH} ตัว</p>
        <label>รหัสผ่านใหม่
          <input type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={72} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>ยืนยันรหัสผ่านใหม่
          <input type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} maxLength={72} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {err && <div className="error" role="alert">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "กำลังบันทึก…" : "เปลี่ยนรหัสผ่าน"}</button>
        <SignOut />
      </form>
    </div>
  );
}
