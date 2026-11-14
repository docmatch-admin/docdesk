-- คิวรอตอบ: นับให้ตรงกับที่เจ้าหน้าที่เห็น
-- 1) ข้อความที่ "ระบบนัด" ส่งถึงลูกค้า (เปลี่ยนวันนัด ยืนยันนัด รับเรื่องขอเลื่อน) = คลินิกตอบแล้ว ไม่ใช่ลูกค้ารอ
--    ข้อความระบบอื่น (เช่น ตอบกลับอัตโนมัติของเพจ) ยังไม่นับเหมือนเดิม
-- 2) ข้อความลูกค้าที่แค่ตอบรับ (โอเค ขอบคุณ) หลังเราตอบ = ไม่ต้องตอบ (no_reply_needed) ไม่นับเวลารอ
--    แต่ยังนับเป็นข้อความเข้า (last_inbound_at) สำหรับหน้าต่างตอบ 24 ชม. ของ Meta
alter table messages add column if not exists no_reply_needed boolean not null default false;

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
    where conversation_id = v_conversation and not imported
      and (sender_type <> 'system' or (direction = 'out' and coalesce(imported_sender_name, '') like 'ระบบนัด%'))
      and not (direction = 'in' and no_reply_needed)
    order by created_at desc, id desc limit 1;
  select max(created_at) filter (where direction = 'in' and sender_type <> 'system'),
         max(created_at) filter (where direction = 'out')
    into v_last_inbound, v_last_outbound
    from messages where conversation_id = v_conversation and not imported
      and (sender_type <> 'system' or (direction = 'out' and coalesce(imported_sender_name, '') like 'ระบบนัด%'));
  select closed_at into v_closed_at from conversations where id = v_conversation;

  update conversations set
    last_direction = v_last_direction,
    last_inbound_at = v_last_inbound,
    -- ข้อความก่อนกดเสร็จแล้ว และข้อความตอบรับ ไม่นับเป็นเวลารอ
    waiting_since = (
      select min(created_at) from messages
      where conversation_id = v_conversation and direction = 'in' and not imported and not no_reply_needed
        and created_at > greatest(coalesce(v_last_outbound, '-infinity'), coalesce(v_closed_at, '-infinity'))
    )
  where id = v_conversation;
  return null;
end;
$$;

-- แชทที่เปิดอยู่: คำนวณคิวใหม่ทันที (แชทที่ระบบนัดตอบล่าสุดจะหลุดจากรอตอบ)
do $$
declare r record;
begin
  for r in select distinct m.conversation_id from messages m join conversations c on c.id = m.conversation_id
           where c.status = 'open' and c.last_direction = 'in' loop
    -- เรียกฟังก์ชันผ่าน trigger ไม่ได้ตรงๆ: ลบแถวชั่วคราวไม่ได้ จึงคำนวณแบบเดียวกันที่นี่
    update conversations c set
      last_direction = coalesce((select direction from messages
        where conversation_id = r.conversation_id and not imported
          and (sender_type <> 'system' or (direction = 'out' and coalesce(imported_sender_name, '') like 'ระบบนัด%'))
          and not (direction = 'in' and no_reply_needed)
        order by created_at desc, id desc limit 1), c.last_direction)
    where c.id = r.conversation_id;
    update conversations c set waiting_since = case when c.last_direction = 'in' then (
      select min(m.created_at) from messages m
      where m.conversation_id = c.id and m.direction = 'in' and not m.imported and not m.no_reply_needed
        and m.created_at > greatest(
          coalesce((select max(created_at) from messages o where o.conversation_id = c.id and not o.imported and o.direction = 'out'
            and (o.sender_type <> 'system' or coalesce(o.imported_sender_name, '') like 'ระบบนัด%')), '-infinity'),
          coalesce(c.closed_at, '-infinity'))) end
    where c.id = r.conversation_id;
  end loop;
end $$;
