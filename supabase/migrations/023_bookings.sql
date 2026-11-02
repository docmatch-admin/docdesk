-- นัดที่ AI ยืนยันกับลูกค้า ค้างแชทไว้จนกว่าเจ้าหน้าที่จะลงนัดจริง
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  service text not null,
  "date" date not null,
  "time" time not null,
  name text,
  phone text,
  status text not null default 'ai_confirmed' check (status in ('ai_confirmed', 'recorded', 'cancelled')),
  confirmed_message_id uuid references messages(id) on delete set null,
  recorded_at timestamptz,
  recorded_by uuid references staff(id) on delete set null,
  last_push_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bookings_conversation_idx on bookings (conversation_id);
create index if not exists bookings_date_idx on bookings ("date", "time");

alter table bookings enable row level security;
drop policy if exists staff_read on bookings;
create policy staff_read on bookings for select to authenticated using (is_staff());
revoke insert, update, delete on bookings from anon, authenticated;

-- ใช้เรียงแท็บรอตอบและกันการปิดเคส
alter table conversations add column if not exists booking_pending boolean not null default false;
create index if not exists conversations_booking_pending_idx on conversations (booking_pending) where booking_pending;

create or replace function refresh_booking_pending() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_conversation uuid := coalesce(new.conversation_id, old.conversation_id);
begin
  update conversations set booking_pending = exists (
    select 1 from bookings where conversation_id = v_conversation and status = 'ai_confirmed'
  ) where id = v_conversation;
  return null;
end;
$$;

drop trigger if exists bookings_refresh_pending on bookings;
create trigger bookings_refresh_pending
  after insert or update or delete on bookings
  for each row execute function refresh_booking_pending();

-- หน้าเว็บแก้ conversations ได้บางคอลัมน์ จึงกันไม่ให้ปลดป้ายหรือปิดเคสเองโดยไม่ผ่าน API
-- auth.uid() เป็น null เมื่อเรียกด้วย service role ซึ่งตรวจสิทธิ์ที่ API แล้ว
create or replace function guard_booking_pending() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.booking_pending is distinct from old.booking_pending then
    raise exception 'ต้องจัดการนัดผ่าน API' using errcode = '42501';
  end if;
  if new.status = 'closed' and old.status <> 'closed' and new.booking_pending then
    raise exception 'ลงนัดก่อน' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists conversations_guard_booking on conversations;
create trigger conversations_guard_booking
  before update on conversations
  for each row execute function guard_booking_pending();

-- การสมัครรับแจ้งเตือนบนเครื่องของเจ้าหน้าที่ อ่านและเขียนผ่าน server เท่านั้น
create table if not exists push_subscriptions (
  endpoint text primary key,
  staff_id uuid not null references staff(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

do $$
begin
  alter publication supabase_realtime add table bookings;
exception when duplicate_object then null;
end $$;
