-- ---------------------------------------------------------------------------
-- นัดหลายวันเป็นชุด (series) เช่น วัคซีนหลายเข็ม
-- ---------------------------------------------------------------------------
create table if not exists appointment_series (
  id uuid primary key default gen_random_uuid(),
  hn text,
  conversation_id uuid references conversations(id) on delete set null,
  title text check (char_length(title) <= 200),
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table appointments add column if not exists series_id uuid references appointment_series(id) on delete set null;
alter table appointments add column if not exists series_seq integer check (series_seq between 1 and 50);
alter table appointments add column if not exists series_label text check (char_length(series_label) <= 50);
-- นัดที่ 2 เป็นต้นไป: นับจากนัดแรกหรือนัดก่อนหน้า ใช้เลื่อนนัดถัดไปตามเมื่อแก้วัน
alter table appointments add column if not exists series_from text check (series_from in ('first', 'previous'));
alter table appointments add column if not exists series_offset_value integer check (series_offset_value between 0 and 3650);
alter table appointments add column if not exists series_offset_unit text check (series_offset_unit in ('day', 'week', 'month'));
create index if not exists appointments_series_idx on appointments (series_id, series_seq);

-- template ชุดนัด แอดมิน/แพทย์สร้างเอง (ไม่ seed)
-- items: [{label, offset_value, offset_unit: day|week|month, from: first|previous}] รายการแรกนับจากวันนี้
create table if not exists appointment_series_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  purpose_id uuid references appointment_purposes(id) on delete set null,
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  -- series: อ่านได้ทุกคนที่เข้าหน้านัดหมาย เขียนผ่าน API
  alter table appointment_series enable row level security;
  revoke all on appointment_series from anon, authenticated;
  grant select on appointment_series to authenticated;
  drop policy if exists staff_read on appointment_series;
  create policy staff_read on appointment_series for select to authenticated using (is_appointment_staff());

  -- template: อ่านได้ทุกคน แก้ได้เฉพาะ admin
  t := 'appointment_series_templates';
  execute format('alter table %I enable row level security', t);
  execute format('revoke all on %I from anon', t);
  execute format('grant select, insert, update, delete on %I to authenticated', t);
  execute format('drop policy if exists staff_read on %I', t);
  execute format('drop policy if exists admin_write on %I', t);
  execute format('create policy staff_read on %I for select to authenticated using (is_appointment_staff())', t);
  execute format('create policy admin_write on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
end $$;

-- ---------------------------------------------------------------------------
-- cache ข้อมูลจาก iService กันระบบ HIS ล่ม (ห้ามส่งเข้า AI เขียนด้วย service role เท่านั้น)
-- ---------------------------------------------------------------------------
create table if not exists his_visit_cache (
  vn text primary key,
  hn text not null,
  patient_name text,
  visit_date date not null,
  visit_time text,
  doctor_name text,
  fetched_at timestamptz not null default now()
);
create index if not exists his_visit_cache_date_idx on his_visit_cache (visit_date);

create table if not exists his_patient_cache (
  hn text primary key,
  full_name text,
  phone text,
  fetched_at timestamptz not null default now()
);
create index if not exists his_patient_cache_name_idx on his_patient_cache (lower(full_name));

-- วันที่ตัดสินมาตามนัด/ไม่มาเสร็จแล้ว ดึง visit ไม่ได้ = ยังไม่เสร็จ mark-attendance ลองใหม่ทุกชั่วโมง
create table if not exists attendance_runs (
  visit_date date primary key,
  done_at timestamptz,
  last_error text,
  attempts integer not null default 0,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['his_visit_cache', 'his_patient_cache', 'attendance_runs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
    execute format('drop policy if exists staff_read on %I', t);
    execute format('create policy staff_read on %I for select to authenticated using (is_appointment_staff())', t);
  end loop;
end $$;
