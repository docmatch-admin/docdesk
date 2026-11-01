-- ป้องกัน /api/webchat: จำกัดต่อ session, จำกัด session ใหม่ต่อ IP, เพดาน AI รายวันของช่องทาง web
-- ทุกตารางเปิด RLS โดยไม่มี policy และฟังก์ชันเรียกได้เฉพาะ service role

create table if not exists webchat_sessions (
  session text primary key,
  ip_hash text,                        -- HMAC ของ IP ล้างทิ้งเมื่อพ้นช่วงนับ
  created_at timestamptz not null default now()
);
create index if not exists webchat_sessions_ip_idx on webchat_sessions (ip_hash, created_at) where ip_hash is not null;

create table if not exists webchat_message_log (
  id bigserial primary key,
  session text not null,
  created_at timestamptz not null default now()
);
create index if not exists webchat_message_log_idx on webchat_message_log (session, created_at);

create table if not exists ai_daily_usage (
  channel text not null,
  day date not null,                   -- วันตามเวลาไทย
  count int not null default 0,
  primary key (channel, day)
);

alter table webchat_sessions enable row level security;
alter table webchat_message_log enable row level security;
alter table ai_daily_usage enable row level security;

-- ตัดสินใจในทรานแซกชันเดียวและล็อกรายคีย์ กันยิงพร้อมกันแล้วเกินเพดาน
-- ข้อความที่ถูกปฏิเสธไม่ถูกนับ พ้นช่วงเวลาแล้วส่งได้อีก
create or replace function webchat_admit(
  p_session text,
  p_ip_hash text,
  p_per_minute int,
  p_per_hour int,
  p_new_sessions_per_hour int,
  p_ai_per_day int
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_minute int;
  v_hour int;
  v_ip_sessions int;
  v_used int;
begin
  perform pg_advisory_xact_lock(hashtextextended('webchat:session:' || p_session, 0));

  select count(*) filter (where created_at > now() - interval '1 minute'), count(*)
    into v_minute, v_hour
    from webchat_message_log
    where session = p_session and created_at > now() - interval '1 hour';
  if v_minute >= p_per_minute then
    return jsonb_build_object('allowed', false, 'ai_allowed', false, 'reason', 'session_minute');
  end if;
  if v_hour >= p_per_hour then
    return jsonb_build_object('allowed', false, 'ai_allowed', false, 'reason', 'session_hour');
  end if;

  if not exists (select 1 from webchat_sessions where session = p_session) then
    perform pg_advisory_xact_lock(hashtextextended('webchat:ip:' || p_ip_hash, 0));
    select count(*) into v_ip_sessions
      from webchat_sessions
      where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
    if v_ip_sessions >= p_new_sessions_per_hour then
      return jsonb_build_object('allowed', false, 'ai_allowed', false, 'reason', 'ip_new_sessions');
    end if;
    insert into webchat_sessions (session, ip_hash) values (p_session, p_ip_hash);
  end if;

  insert into webchat_message_log (session) values (p_session);

  insert into ai_daily_usage as u (channel, day, count)
    values ('web', (now() at time zone 'Asia/Bangkok')::date, 1)
    on conflict (channel, day) do update set count = u.count + 1 where u.count < p_ai_per_day
    returning u.count into v_used;

  -- เก็บกวาดเป็นครั้งคราว: ไม่เก็บ hash ของ IP นานเกินจำเป็น
  if random() < 0.01 then
    delete from webchat_message_log where created_at < now() - interval '2 hours';
    update webchat_sessions set ip_hash = null where ip_hash is not null and created_at < now() - interval '2 hours';
  end if;

  return jsonb_build_object('allowed', true, 'ai_allowed', v_used is not null, 'reason', null);
end;
$$;

revoke all on function webchat_admit(text, text, int, int, int, int) from public, anon, authenticated;
grant execute on function webchat_admit(text, text, int, int, int, int) to service_role;
