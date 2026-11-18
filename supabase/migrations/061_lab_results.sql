-- 061: ผลแล็บจากแล็บนอก (Bangkok Medical Lab) ดึงอัตโนมัติชั่วโมงละครั้ง 13:00–18:00 น. → แจ้งคนไข้ทาง LINE → คนไข้เปิด PDF ผ่าน LIFF
-- อ่านอย่างเดียวจากระบบแล็บ · ผลแล็บไม่ส่งเข้า AI (ไม่อยู่ในข้อความแชท ข้อความแจ้งเป็น sender_type 'system')
-- เขียนผ่าน API ด้วย service role เท่านั้น หน้าเว็บอ่านได้เฉพาะเจ้าหน้าที่ที่อ่านแชทได้ (is_staff: ไม่รวมห้องยา)

create table if not exists lab_results (
  id uuid primary key default gen_random_uuid(),
  bml_id text not null unique,
  ln text,
  lis_ln text,
  -- HN ของคลินิกที่แล็บอ่านได้จากใบส่งตรวจ + สถานะการอ่าน (ไม่ ok = ต้องจับคู่เอง)
  location_hn text,
  hn_extraction_status text,
  -- คนไข้ใน DocDesk (patients.hn) ที่จับคู่ได้
  patient_id text references patients(hn) on update cascade on delete set null,
  patient_name text,
  gender text,
  order_datetime timestamptz,
  status text,
  version_number integer not null default 1,
  pdf_path text,
  pdf_version integer,
  pdf_error text,
  match_status text not null default 'unmatched' check (match_status in ('matched', 'unmatched', 'manual')),
  matched_by uuid references staff(id) on delete set null,
  matched_at timestamptz,
  -- แจ้งคนไข้: pending รอส่ง · sent ส่งแล้ว · unreachable ไม่ได้ผูก LINE (ไม่ส่งอะไร ไม่เข้ารายการโทร แสดงสถานะในหน้าผลแล็บเท่านั้น)
  -- · failed ส่ง LINE ไม่สำเร็จ · skipped ไม่ส่งอัตโนมัติ (ผลเก่าตอนเริ่มระบบ)
  notify_status text not null default 'pending' check (notify_status in ('pending', 'sent', 'unreachable', 'failed', 'skipped')),
  notified_at timestamptz,
  notified_version integer,
  notify_error text,
  team_notified_version integer,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count integer not null default 0,
  bml_imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lab_results_patient_idx on lab_results (patient_id, order_datetime desc);
create index if not exists lab_results_order_idx on lab_results (order_datetime desc);
create index if not exists lab_results_open_idx on lab_results (notify_status) where notify_status in ('pending', 'unreachable', 'failed');

alter table lab_results enable row level security;
revoke all on lab_results from anon, authenticated;
grant select on lab_results to authenticated;
drop policy if exists staff_read on lab_results;
create policy staff_read on lab_results for select to authenticated using (is_staff());

-- ไฟล์ PDF: bucket private เปิดผ่าน signed URL อายุสั้นจาก server เท่านั้น (ไม่มี policy ให้ anon/authenticated)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lab-results', 'lab-results', false, 26214400, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- สรุปโควตา LINE แยกประเภท "ผลแล็บ"
alter table line_sends drop constraint if exists line_sends_kind_check;
alter table line_sends add constraint line_sends_kind_check check (kind in ('chat', 'appointment', 'reminder', 'broadcast', 'lab'));

-- badge "รอจับคู่" ที่เมนูอัปเดตเองเมื่อมีผลใหม่
do $$
begin
  alter publication supabase_realtime add table lab_results;
exception when duplicate_object then null;
end $$;
