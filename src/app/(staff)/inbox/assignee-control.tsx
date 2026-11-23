"use client";

interface StaffOption { id: string; display_name: string; active: boolean }

/** admin เปลี่ยนได้ทุกแชท · agent รับเคสที่ไม่มีผู้ดูแล หรือส่งต่อเคสของตัวเอง */
export function AssigneeControl({ me, assignedTo, staff, onChange, showClaim = false }: {
  me: { id: string; role: string };
  assignedTo: string | null;
  staff: StaffOption[];
  onChange: (to: string | null) => void;
  /** มือถือ (ตามแบบ): ปุ่ม "รับเคสนี้" อยู่ที่เดิมเสมอ รับไม่ได้ = จาง */
  showClaim?: boolean;
}) {
  const isAdmin = me.role === "admin";
  const mine = assignedTo === me.id;
  const name = staff.find((s) => s.id === assignedTo)?.display_name ?? "ไม่มี";
  const options = staff.filter((s) => s.active || s.id === assignedTo);
  const canClaim = !mine && (isAdmin || !assignedTo);
  const canChange = isAdmin || mine;

  return (
    <div className="assignee">
      {canChange ? (
        <label className="mode-select">
          ผู้ดูแล
          <select value={assignedTo ?? ""} onChange={(e) => onChange(e.target.value || null)}>
            {isAdmin && <option value="">ไม่มี</option>}
            {options.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
          </select>
        </label>
      ) : (
        <span className="muted small">ผู้ดูแล: {name}</span>
      )}
      {(canClaim || showClaim) && (
        <button className="btn ghost small assignee-claim" disabled={!canClaim} title={canClaim ? undefined : mine ? "คุณดูแลเคสนี้อยู่" : "เคสนี้มีผู้ดูแลแล้ว"} onClick={() => onChange(me.id)}>รับเคสนี้</button>
      )}
    </div>
  );
}
