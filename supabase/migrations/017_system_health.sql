-- ตรวจสุขภาพระบบ
create table if not exists system_errors (
  id bigserial primary key,
  source text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists system_errors_recent_idx on system_errors (source, created_at desc);

-- ผลตรวจล่าสุดของแต่ละข้อ
create table if not exists system_health (
  check_name text primary key,
  ok boolean not null,
  detail text not null default '',
  checked_at timestamptz not null default now()
);

-- เวลาล่าสุดของงานประจำ และการแจ้งเตือนล่าสุด
create table if not exists system_heartbeat (
  name text primary key,
  at timestamptz not null default now()
);

alter table system_errors enable row level security;
alter table system_health enable row level security;
alter table system_heartbeat enable row level security;

drop policy if exists staff_read on system_errors;
create policy staff_read on system_errors for select to authenticated using (is_staff());
-- แถบแดงต้องแสดงกับเจ้าหน้าที่ทุกคน
drop policy if exists staff_read on system_health;
create policy staff_read on system_health for select to authenticated using (is_staff());
