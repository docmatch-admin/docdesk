-- ข้อความที่เพจตอบนอก DocDesk เช่น Meta Business Suite
alter table messages add column if not exists imported_sender_name text;

-- echo ของข้อความที่ DocDesk ส่งเองค้นด้วย mid และ Meta ส่ง echo เดียวกันซ้ำพร้อมกันได้ จึงกันซ้ำที่ฐานข้อมูล
create unique index if not exists messages_external_id_key on messages (external_id) where external_id is not null;

-- ข้อความระบบ เช่น ตอบกลับอัตโนมัติของเพจ ไม่นับเป็นการตอบ แชทยังอยู่ในรอตอบ
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
  -- ข้อความนำเข้าเป็นประวัติเก่า ไม่เปลี่ยนสถานะคิว
  if (tg_op = 'INSERT' and new.imported) or (tg_op = 'DELETE' and old.imported) then
    return null;
  end if;

  select direction into v_last_direction from messages
    where conversation_id = v_conversation and not imported and sender_type <> 'system'
    order by created_at desc, id desc limit 1;
  select max(created_at) filter (where direction = 'in'), max(created_at) filter (where direction = 'out')
    into v_last_inbound, v_last_outbound
    from messages where conversation_id = v_conversation and not imported and sender_type <> 'system';
  select closed_at into v_closed_at from conversations where id = v_conversation;

  update conversations set
    last_direction = v_last_direction,
    last_inbound_at = v_last_inbound,
    -- ข้อความก่อนกดเสร็จแล้วไม่นับเป็นเวลารอ
    waiting_since = (
      select min(created_at) from messages
      where conversation_id = v_conversation and direction = 'in' and not imported
        and created_at > greatest(coalesce(v_last_outbound, '-infinity'), coalesce(v_closed_at, '-infinity'))
    )
  where id = v_conversation;
  return null;
end;
$$;
