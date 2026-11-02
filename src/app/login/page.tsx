"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toLoginEmail } from "@/lib/staff-login";
import { supabaseBrowser } from "@/lib/supabase/browser";

export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabaseBrowser().auth.signInWithPassword({ email: toLoginEmail(login), password });
    setBusy(false);
    if (error) return setErr("ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    router.replace("/inbox");
    router.refresh();
  }

  return (
    <div className="login">
      <form onSubmit={submit} className="card login-card">
        <div className="brand big">Doc<span>Desk</span></div>
        <p className="muted">สำหรับเจ้าหน้าที่คลินิก</p>
        <label>ชื่อผู้ใช้หรืออีเมล<input autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={login} onChange={(e) => setLogin(e.target.value)} required /></label>
        <label>รหัสผ่าน<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}</button>
      </form>
    </div>
  );
}
