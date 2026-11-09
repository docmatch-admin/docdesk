-- ระบบนัดครั้งต่อไป: พยาบาลห้องยาออกใบนัด ระบบส่งข้อความนัดและเตือนก่อนวันนัด 1 วัน
-- ข้อมูลนัดไม่ส่งเข้า AI: ข้อความของระบบนัดเป็น sender_type 'system' ซึ่ง suggest.ts ข้ามอยู่แล้ว
-- เขียนผ่าน API ด้วย service role เท่านั้น หน้าเว็บอ่านได้ตาม RLS

-- ---------------------------------------------------------------------------
-- role ห้องยา: เข้าได้เฉพาะหน้านัดหมาย ไม่เห็นแชท
-- ---------------------------------------------------------------------------
alter table staff drop constraint if exists staff_role_check;
alter table staff add constraint staff_role_check check (role in ('admin', 'agent', 'pharmacy'));

-- is_staff() คือสิทธิ์อ่านแชท ห้องยาจึงไม่ผ่าน RLS ของแชท ข้อความ แท็ก ฯลฯ
create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active and not must_change_password and role <> 'pharmacy');
$$;

create or replace function is_appointment_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active and not must_change_password and role in ('admin', 'agent', 'pharmacy'));
$$;
grant execute on function is_appointment_staff() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ผูกแชทกับคนไข้ (HN) 1 แชทมี HN เดียว 1 HN มีได้หลายแชท เช่น LINE และ Facebook
-- ---------------------------------------------------------------------------
create table if not exists patient_links (
  conversation_id uuid primary key references conversations(id) on delete cascade,
  hn text not null check (char_length(btrim(hn)) between 1 and 30),
  patient_name text,
  phone text,
  source text not null default 'staff' check (source in ('staff', 'link_code')),
  linked_by uuid references staff(id) on delete set null,
  linked_at timestamptz not null default now()
);
create index if not exists patient_links_hn_idx on patient_links (hn, linked_at desc);

alter table patient_links enable row level security;
revoke all on patient_links from anon, authenticated;
grant select on patient_links to authenticated;
drop policy if exists staff_read on patient_links;
create policy staff_read on patient_links for select to authenticated using (can_read_conversation(conversation_id));

-- ---------------------------------------------------------------------------
-- นัดหมาย
-- ---------------------------------------------------------------------------
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'docdesk' check (source in ('docdesk', 'his')),
  -- เก็บไว้เผื่อดึงจาก HIS ภายหลัง ตอนนี้ไม่ใช้
  his_appoint_id text unique,
  hn text,
  patient_name text not null check (char_length(btrim(patient_name)) between 1 and 200),
  phone text,
  conversation_id uuid references conversations(id) on delete set null,
  -- นัดที่ AI รับไว้ในแชท แปลงเป็นนัดจริงแล้ว
  booking_id uuid references bookings(id) on delete set null,
  appoint_date date not null,
  appoint_time time not null,
  purpose text,
  provider text,
  note text,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'confirmed', 'reschedule_requested', 'cancelled', 'attended', 'no_show')),
  link_code text not null unique check (link_code ~ '^[A-Z0-9]{6}$'),
  confirm_sent_at timestamptz,
  reminder_sent_at timestamptz,
  -- ลองส่งเตือนแล้ว (สำเร็จหรือไม่ก็ตาม) กันส่งซ้ำเมื่อ cron รันซ้อนกัน
  reminder_attempted_at timestamptz,
  last_send_error text,
  called_at timestamptz,
  called_by uuid references staff(id) on delete set null,
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists appointments_date_idx on appointments (appoint_date, appoint_time);
create index if not exists appointments_hn_idx on appointments (hn);
create index if not exists appointments_conversation_idx on appointments (conversation_id);
create index if not exists appointments_reminder_idx on appointments (appoint_date)
  where reminder_sent_at is null and reminder_attempted_at is null and status in ('scheduled', 'confirmed');

-- log ทุกการเปลี่ยนสถานะ การส่ง และการกดปุ่ม
create table if not exists appointment_events (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments(id) on delete cascade,
  kind text not null,
  actor text not null check (actor in ('staff', 'customer', 'system')),
  staff_id uuid references staff(id) on delete set null,
  channel text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists appointment_events_appointment_idx on appointment_events (appointment_id, created_at);

alter table appointments enable row level security;
alter table appointment_events enable row level security;
revoke all on appointments from anon, authenticated;
revoke all on appointment_events from anon, authenticated;
grant select on appointments to authenticated;
grant select on appointment_events to authenticated;
drop policy if exists staff_read on appointments;
create policy staff_read on appointments for select to authenticated using (is_appointment_staff());
drop policy if exists staff_read on appointment_events;
create policy staff_read on appointment_events for select to authenticated using (is_appointment_staff());

-- ---------------------------------------------------------------------------
-- ตั้งค่า (แก้ในหน้าตั้งค่า → นัดหมาย ด้วยสิทธิ์ admin ตาม RLS ของ settings)
-- ---------------------------------------------------------------------------
insert into settings (key, value) values ('appointment_settings', '{
  "reminder_time": "10:00",
  "send_purpose_in_message": false,
  "template_th": "เรียน คุณ{name}\nนัดหมายครั้งต่อไปที่ {clinic}\nวัน{date}\nเวลา {time} น.\nสอบถามโทร {phone}",
  "template_en": "Dear {name},\nYour next appointment at {clinic}\n{date}\nat {time}\nQuestions? Call {phone}",
  "clinic_phone": "02-000-4586",
  "clinic_address": "",
  "line_oa_id": "@p49clinic"
}') on conflict (key) do nothing;

do $$
begin
  alter publication supabase_realtime add table appointments;
exception when duplicate_object then null;
end $$;
