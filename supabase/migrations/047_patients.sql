-- คนไข้ของ DocDesk: สร้าง/อัปเดตเฉพาะตอนบันทึกนัดหรือผูกแชทกับ HN (ไม่ sync ทะเบียนคนไข้ทั้งหมดจาก HIS)
-- ใช้ค้นด้วยชื่อ (iService ค้นชื่อไม่ได้) และเป็นเบอร์สำรองตอน iService ล่ม ไม่เก็บเลขบัตรประชาชน ไม่ส่งเข้า AI
create table if not exists patients (
  hn text primary key check (hn ~ '^[0-9]{1,15}$'),
  full_name text,
  phone text,
  phone_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists patients_name_idx on patients (lower(full_name));
create index if not exists patients_phone_idx on patients (phone);

alter table patients enable row level security;
revoke all on patients from anon, authenticated;
grant select on patients to authenticated;
drop policy if exists staff_read on patients;
create policy staff_read on patients for select to authenticated using (is_appointment_staff());

-- ย้ายข้อมูลจาก cache ของ patient_list เดิม (HN 9 หลัก) แล้วเลิกใช้ตารางนั้น
do $$
begin
  if to_regclass('public.his_patient_cache') is not null then
    insert into patients (hn, full_name, phone, phone_fetched_at, created_at, updated_at)
    select lpad(hn, 9, '0'), full_name, phone, fetched_at, fetched_at, fetched_at
    from his_patient_cache
    where hn ~ '^[0-9]{1,9}$'
    on conflict (hn) do nothing;
    drop table his_patient_cache;
  end if;
end $$;

-- คนไข้ที่มีนัดหรือผูกแชทอยู่แล้วก่อนมีตารางนี้
insert into patients (hn, full_name, phone, created_at, updated_at)
select distinct on (lpad(a.hn, 9, '0')) lpad(a.hn, 9, '0'), a.patient_name, a.phone, a.created_at, a.created_at
from appointments a
where a.hn ~ '^[0-9]{1,9}$'
order by lpad(a.hn, 9, '0'), a.created_at desc
on conflict (hn) do nothing;
