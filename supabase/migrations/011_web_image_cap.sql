-- แยกเพดานรูปของเว็บออกจากเพดาน AI: รูปไม่เรียก AI แต่กินพื้นที่ Storage
-- rate limit ต่อ session และต่อ IP ยังใช้ชุดเดียวกับข้อความ
-- ตัวนับรูปเก็บใน ai_daily_usage ด้วย channel = 'web_image'

-- ตรวจอย่างเดียว ไม่เขียน: ข้อความที่ถูกปฏิเสธต้องไม่ถูกนับ
create or replace function webchat_gate_check(
  p_session text,
  p_ip_hash text,
  p_per_minute int,
  p_per_hour int,
  p_new_sessions_per_hour int
) returns text
language plpgsql
set search_path = public
as $$
declare
  v_minute int;
  v_hour int;
  v_ip_sessions int;
begin
  perform pg_advisory_xact_lock(hashtextextended('webchat:session:' || p_session, 0));

  select count(*) filter (where created_at > now() - interval '1 minute'), count(*)
    into v_minute, v_hour
    from webchat_message_log
    where session = p_session and created_at > now() - interval '1 hour';
  if v_minute >= p_per_minute then return 'session_minute'; end if;
  if v_hour >= p_per_hour then return 'session_hour'; end if;

  if not exists (select 1 from webchat_sessions where session = p_session) then
    perform pg_advisory_xact_lock(hashtextextended('webchat:ip:' || p_ip_hash, 0));
    select count(*) into v_ip_sessions
      from webchat_sessions
      where ip_hash = p_ip_hash and created_at > now() - interval '1 hour';
    if v_ip_sessions >= p_new_sessions_per_hour then return 'ip_new_sessions'; end if;
  end if;
  return null;
end;
$$;

create or replace function webchat_gate_record(p_session text, p_ip_hash text) returns void
language plpgsql
set search_path = public
as $$
begin
  insert into webchat_sessions (session, ip_hash) values (p_session, p_ip_hash) on conflict (session) do nothing;
  insert into webchat_message_log (session) values (p_session);

  -- เก็บกวาดเป็นครั้งคราว: ไม่เก็บ hash ของ IP นานเกินจำเป็น
  if random() < 0.01 then
    delete from webchat_message_log where created_at < now() - interval '2 hours';
    update webchat_sessions set ip_hash = null where ip_hash is not null and created_at < now() - interval '2 hours';
  end if;
end;
$$;

-- ข้อความ: นับเพดาน AI เหมือนเดิม
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
  v_reason text;
  v_used int;
begin
  v_reason := webchat_gate_check(p_session, p_ip_hash, p_per_minute, p_per_hour, p_new_sessions_per_hour);
  if v_reason is not null then
    return jsonb_build_object('allowed', false, 'ai_allowed', false, 'reason', v_reason);
  end if;
  perform webchat_gate_record(p_session, p_ip_hash);

  insert into ai_daily_usage as u (channel, day, count)
    values ('web', (now() at time zone 'Asia/Bangkok')::date, 1)
    on conflict (channel, day) do update set count = u.count + 1 where u.count < p_ai_per_day
    returning u.count into v_used;

  return jsonb_build_object('allowed', true, 'ai_allowed', v_used is not null, 'reason', null);
end;
$$;

-- รูป: นับเพดานรูปรายวันแทนเพดาน AI ถ้าเต็มไม่นับใน rate limit ของ session
create or replace function webchat_admit_image(
  p_session text,
  p_ip_hash text,
  p_per_minute int,
  p_per_hour int,
  p_new_sessions_per_hour int,
  p_images_per_day int
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_reason text;
  v_used int;
begin
  v_reason := webchat_gate_check(p_session, p_ip_hash, p_per_minute, p_per_hour, p_new_sessions_per_hour);
  if v_reason is not null then
    return jsonb_build_object('allowed', false, 'reason', v_reason);
  end if;

  insert into ai_daily_usage as u (channel, day, count)
    values ('web_image', (now() at time zone 'Asia/Bangkok')::date, 1)
    on conflict (channel, day) do update set count = u.count + 1 where u.count < p_images_per_day
    returning u.count into v_used;
  if v_used is null then
    return jsonb_build_object('allowed', false, 'reason', 'images_day');
  end if;

  perform webchat_gate_record(p_session, p_ip_hash);
  return jsonb_build_object('allowed', true, 'reason', null);
end;
$$;

revoke all on function webchat_gate_check(text, text, int, int, int) from public, anon, authenticated;
revoke all on function webchat_gate_record(text, text) from public, anon, authenticated;
revoke all on function webchat_admit_image(text, text, int, int, int, int) from public, anon, authenticated;
grant execute on function webchat_gate_check(text, text, int, int, int) to service_role;
grant execute on function webchat_gate_record(text, text) to service_role;
grant execute on function webchat_admit_image(text, text, int, int, int, int) to service_role;
