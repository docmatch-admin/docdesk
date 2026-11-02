import { redirect } from "next/navigation";
import { getStaffContext } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

const ACTION: Record<string, string> = { open: "เปิดแชท", reveal: "กดแสดงข้อความ", export: "ส่งออก", untag: "เอาออกจากแชทลับ" };
const timeTh = (iso: string) => new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" });

interface Row {
  id: number;
  action: string;
  created_at: string;
  staff: { display_name: string } | null;
  conversations: { id: string; contacts: { display_name: string | null } | null } | null;
}

/** ประวัติการเข้าถึงแชทลับ เฉพาะ admin */
export default async function SensitiveLogPage() {
  const me = await getStaffContext();
  if (me?.role !== "admin") redirect("/inbox");
  const sb = await supabaseServer();
  const { data } = await sb.from("sensitive_access_log")
    .select("id, action, created_at, staff(display_name), conversations(id, contacts(display_name))")
    .order("created_at", { ascending: false }).limit(500);
  const rows = (data ?? []) as unknown as Row[];

  return (
    <div className="page">
      <h1>ประวัติเข้าถึงแชทลับ</h1>
      <p className="muted small">แสดง 500 รายการล่าสุด</p>
      <section className="card">
        {rows.length === 0 && <div className="muted small">ยังไม่มีรายการ</div>}
        {rows.length > 0 && (
          <div className="report-table-wrap">
            <table className="report-table sensitive-log-table">
              <thead><tr><th scope="col">เวลา</th><th scope="col">เจ้าหน้าที่</th><th scope="col">การกระทำ</th><th scope="col">แชท</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{timeTh(r.created_at)}</td>
                    <td>{r.staff?.display_name ?? "–"}</td>
                    <td>{ACTION[r.action] ?? r.action}</td>
                    <td>{r.conversations ? <a href={`/inbox?c=${r.conversations.id}`}>{r.conversations.contacts?.display_name || "ลูกค้า"}</a> : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
