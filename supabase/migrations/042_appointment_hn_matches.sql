-- นัดของคนไข้ใหม่ (ยังไม่มี HN) ที่ทำจากแชท: วันนัดถ้ามี visit ที่ชื่อ (และเบอร์) ตรง
-- mark-attendance สร้างข้อเสนอจับคู่ให้แอดมินยืนยัน ยืนยันแล้ว → ผูก HN กับแชท ชื่อจริง·HN และนัดเป็น attended
create table if not exists appointment_hn_matches (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  hn text not null,
  his_name text,
  -- name = ชื่อตรง, name_phone = ชื่อและเบอร์ตรง
  matched_by text not null check (matched_by in ('name', 'name_phone')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  decided_by uuid references staff(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (appointment_id, hn)
);
create index if not exists appointment_hn_matches_pending_idx on appointment_hn_matches (created_at) where status = 'pending';

alter table appointment_hn_matches enable row level security;
revoke all on appointment_hn_matches from anon, authenticated;
grant select on appointment_hn_matches to authenticated;
drop policy if exists admin_read on appointment_hn_matches;
create policy admin_read on appointment_hn_matches for select to authenticated using (is_admin());
