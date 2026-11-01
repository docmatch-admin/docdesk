-- ลูกค้าทักกลับมาแล้วระบบเอาแท็ก "นัดแล้ว" ออก ไม่ได้แปลว่าการนัดครั้งก่อนไม่เคยเกิด
-- รายงานจึงตัดเฉพาะแท็กที่เจ้าหน้าที่เอาออกเอง (ติดผิด) ไม่ตัดแท็กที่ระบบเอาออก
create or replace function tag_report(p_unit text, p_from timestamptz, p_to timestamptz)
returns table (bucket text, tag text, chats bigint)
language sql stable
set search_path = public
as $$
  with latest as (
    select distinct on (conversation_id, tag) conversation_id, tag, action
    from tag_events
    where action = 'add' or "by" = 'staff'
    order by conversation_id, tag, created_at desc, id desc
  )
  select
    to_char(date_trunc(case when p_unit = 'month' then 'month' else 'day' end, e.created_at at time zone 'Asia/Bangkok'), 'YYYY-MM-DD'),
    e.tag,
    count(distinct e.conversation_id)
  from tag_events e
  join latest l on l.conversation_id = e.conversation_id and l.tag = e.tag
  where e.action = 'add' and l.action = 'add' and e.created_at >= p_from and e.created_at < p_to
  group by 1, 2
  order by 1, 2;
$$;

create or replace function tag_report_chats(p_tag text, p_from timestamptz, p_to timestamptz)
returns table (display_name text, channel text, tag text, tagged_at timestamptz)
language sql stable
set search_path = public
as $$
  with latest as (
    select distinct on (conversation_id, tag) conversation_id, tag, action
    from tag_events
    where action = 'add' or "by" = 'staff'
    order by conversation_id, tag, created_at desc, id desc
  )
  select ct.display_name, ch.type::text, e.tag, min(e.created_at)
  from tag_events e
  join latest l on l.conversation_id = e.conversation_id and l.tag = e.tag
  join conversations c on c.id = e.conversation_id
  join contacts ct on ct.id = c.contact_id
  join channels ch on ch.id = c.channel_id
  where e.action = 'add' and l.action = 'add' and e.created_at >= p_from and e.created_at < p_to
    and (p_tag is null or e.tag = p_tag)
  group by c.id, ct.display_name, ch.type, e.tag
  order by min(e.created_at), e.tag, c.id;
$$;
