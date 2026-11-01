-- แท็บ รอตอบ / ทั้งหมด / เสร็จแล้ว: กรองและเรียงที่ฐานข้อมูล
-- waiting_since = ข้อความแรกที่ยังไม่ได้ตอบ ลูกค้าที่ทักซ้ำจะได้ไม่เสียคิว
alter table conversations
  add column if not exists last_direction text check (last_direction in ('in', 'out')),
  add column if not exists last_inbound_at timestamptz,
  add column if not exists waiting_since timestamptz,
  add column if not exists closed_at timestamptz;

-- ใช้ trigger เพราะข้อความเข้าระบบจากหลายทาง และการส่งรูปที่ล้มเหลวจะลบแถวข้อความทิ้ง
create or replace function refresh_conversation_queue() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_conversation uuid := coalesce(new.conversation_id, old.conversation_id);
  v_last_direction text;
  v_last_inbound timestamptz;
  v_last_outbound timestamptz;
  v_closed_at timestamptz;
begin
  select direction into v_last_direction from messages
    where conversation_id = v_conversation order by created_at desc, id desc limit 1;
  select max(created_at) filter (where direction = 'in'), max(created_at) filter (where direction = 'out')
    into v_last_inbound, v_last_outbound
    from messages where conversation_id = v_conversation;
  select closed_at into v_closed_at from conversations where id = v_conversation;

  update conversations set
    last_direction = v_last_direction,
    last_inbound_at = v_last_inbound,
    -- ข้อความก่อนกดเสร็จแล้วไม่นับเป็นเวลารอ
    waiting_since = (
      select min(created_at) from messages
      where conversation_id = v_conversation and direction = 'in'
        and created_at > greatest(coalesce(v_last_outbound, '-infinity'), coalesce(v_closed_at, '-infinity'))
    )
  where id = v_conversation;
  return null;
end;
$$;

drop trigger if exists messages_refresh_queue on messages;
create trigger messages_refresh_queue
  after insert or delete on messages
  for each row execute function refresh_conversation_queue();

-- closed_at เก็บไว้หลังเปิดใหม่ ใช้เป็นจุดเริ่มนับเวลารอ
create or replace function track_conversation_status() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'closed' and old.status <> 'closed' then
    new.closed_at := now();
  elsif new.status = 'open' and old.status = 'closed' then
    new.waiting_since := case when new.last_direction = 'in' then new.last_inbound_at end;
  end if;
  return new;
end;
$$;

drop trigger if exists conversations_track_status on conversations;
create trigger conversations_track_status
  before update of status on conversations
  for each row execute function track_conversation_status();

-- ข้อมูลเดิม
update conversations c set
  last_direction = (select direction from messages m where m.conversation_id = c.id order by created_at desc, id desc limit 1),
  last_inbound_at = (select max(created_at) from messages m where m.conversation_id = c.id and m.direction = 'in'),
  waiting_since = (
    select min(m.created_at) from messages m
    where m.conversation_id = c.id and m.direction = 'in'
      and m.created_at > coalesce((select max(o.created_at) from messages o where o.conversation_id = c.id and o.direction = 'out'), '-infinity')
  ),
  closed_at = case when c.status = 'closed' then c.last_message_at end;

create index if not exists conversations_waiting_idx on conversations (needs_human desc, waiting_since)
  where status = 'open' and last_direction = 'in';
create index if not exists conversations_closed_idx on conversations (closed_at desc) where status = 'closed';
