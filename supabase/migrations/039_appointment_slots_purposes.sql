-- ระบบนัด: preset เหตุผลนัด, การปฏิบัติตัว, เวลานัดแบบช่วง/เวลาตรง, เวลาเปิดคลินิกและวันหยุดพิเศษ

-- ---------------------------------------------------------------------------
-- preset เหตุผลนัด
-- ---------------------------------------------------------------------------
create table if not exists appointment_purposes (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  -- เลือกแล้วเลือกวันนัดให้ = วันนี้ + default_days
  default_days integer check (default_days between 1 and 3650),
  -- ค่าเริ่มต้นของ "การปฏิบัติตัว" ส่งในข้อความนัดเสมอ
  reminder_extra_text text check (char_length(reminder_extra_text) <= 500),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists appointment_purposes_name_key on appointment_purposes (lower(btrim(name)));

insert into appointment_purposes (name, default_days, reminder_extra_text, sort_order) values
  ('ฟังผลแล็บ', 7, null, 10),
  ('เจาะเลือด', null, 'งดน้ำงดอาหาร 8–12 ชม. (ดื่มน้ำเปล่าได้)', 20),
  ('ติดตามอาการ', 7, null, 30),
  ('โรคเรื้อรัง-รับยาต่อเนื่อง', 30, 'กรุณานำยาเดิมมาด้วย', 40),
  ('ทำแผล', 2, null, 50),
  ('ตัดไหม', 7, null, 60),
  ('ฉีดยา-วัคซีน', null, null, 70),
  ('อื่นๆ', null, null, 80)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- เวลาเปิดคลินิก: แต่ละวันในสัปดาห์มีหลายช่วง ไม่มีแถว = ปิดทั้งวัน (0 = อาทิตย์)
-- ---------------------------------------------------------------------------
create table if not exists clinic_hours (
  weekday smallint not null check (weekday between 0 and 6),
  slot_id text not null check (slot_id ~ '^[a-z0-9_-]{1,30}$'),
  label text not null check (char_length(btrim(label)) between 1 and 50),
  start_time time not null,
  end_time time not null,
  sort_order integer not null default 0,
  primary key (weekday, slot_id),
  check (end_time > start_time)
);

insert into clinic_hours (weekday, slot_id, label, start_time, end_time, sort_order)
select d, 'morning', 'ช่วงเช้า', '08:00', '12:00', 10 from generate_series(0, 6) d
union all
select d, 'afternoon', 'ช่วงบ่าย', '13:00', '18:00', 20 from generate_series(1, 5) d
on conflict do nothing;

-- วันหยุดพิเศษ
create table if not exists clinic_closures (
  closed_on date primary key,
  reason text check (char_length(reason) <= 200),
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);

-- เจ้าหน้าที่ทุกคน (รวมห้องยา) อ่านได้ แก้ได้เฉพาะ admin
do $$
declare t text;
begin
  foreach t in array array['appointment_purposes', 'clinic_hours', 'clinic_closures'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('drop policy if exists staff_read on %I', t);
    execute format('drop policy if exists admin_write on %I', t);
    execute format('create policy staff_read on %I for select to authenticated using (is_appointment_staff())', t);
    execute format('create policy admin_write on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- นัด: เหตุผลนัด การปฏิบัติตัว และเวลานัด
-- ---------------------------------------------------------------------------
alter table appointments rename column purpose to purpose_text;
alter table appointments add column if not exists purpose_id uuid references appointment_purposes(id) on delete set null;
alter table appointments add column if not exists instructions text check (char_length(instructions) <= 1000);

-- slot = มาได้ในช่วง (ตรวจตามลำดับคิว), exact = เวลาตรง (time_end ว่าง)
alter table appointments rename column appoint_time to time_start;
alter table appointments add column if not exists time_mode text not null default 'exact' check (time_mode in ('slot', 'exact'));
alter table appointments add column if not exists slot_id text;
alter table appointments add column if not exists time_end time;
alter table appointments drop constraint if exists appointments_time_check;
alter table appointments add constraint appointments_time_check check (
  (time_mode = 'exact' and time_end is null)
  or (time_mode = 'slot' and slot_id is not null and time_end is not null and time_end > time_start)
);

drop index if exists appointments_date_idx;
create index if not exists appointments_date_idx on appointments (appoint_date, time_start);
create index if not exists appointments_purpose_idx on appointments (purpose_id);

-- เทมเพลตเดิมเขียน "เวลา {time} น." ตอนนี้ {time} คือข้อความเวลาทั้งวลี เช่น "มาได้ช่วง 08.00–12.00 น. (ตรวจตามลำดับคิว)"
update settings set value = jsonb_set(jsonb_set(value,
    '{template_th}', to_jsonb(replace(value->>'template_th', 'เวลา {time} น.', '{time}'))),
    '{template_en}', to_jsonb(replace(value->>'template_en', 'at {time}', '{time}')))
where key = 'appointment_settings' and value ? 'template_th' and value ? 'template_en';
