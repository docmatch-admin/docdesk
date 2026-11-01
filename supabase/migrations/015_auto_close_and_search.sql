-- ย้ายไปเสร็จแล้วอัตโนมัติ และค้นหาแชท
-- last_direction, last_inbound_at, closed_at มีแล้วจาก migration 014
alter table conversations add column if not exists reopened_at timestamptz;

-- reopened_at: กด "เปิดใหม่" แชทเก่าแล้ว cron ต้องไม่ปิดซ้ำทันที
create or replace function track_conversation_status() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'closed' and old.status <> 'closed' then
    new.closed_at := now();
  elsif new.status = 'open' and old.status = 'closed' then
    new.reopened_at := now();
    new.waiting_since := case when new.last_direction = 'in' then new.last_inbound_at end;
  end if;
  return new;
end;
$$;

insert into settings (key, value) values ('auto_close_hours', '24') on conflict (key) do nothing;

-- cron ค้นทุกนาที
create index if not exists conversations_auto_close_idx on conversations (last_message_at)
  where status = 'open' and last_direction = 'out';

-- ค้นจากชื่อ ข้อความล่าสุด เนื้อหาแชท และแท็ก ใช้สิทธิ์ของผู้เรียก จึงอยู่ภายใต้ RLS
create or replace function search_conversations(p_query text)
returns table (id uuid)
language sql stable
set search_path = public
as $$
  with q as (
    select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
  )
  select c.id
  from conversations c
  join contacts ct on ct.id = c.contact_id
  cross join q
  where ct.display_name ilike q.pattern
     or c.last_message_preview ilike q.pattern
     or exists (select 1 from unnest(c.tags) t where t ilike q.pattern)
     or exists (
       select 1 from messages m
       where m.conversation_id = c.id and (m.body ilike q.pattern or m.body_th ilike q.pattern)
     )
  order by c.last_message_at desc
  limit 200;
$$;

revoke all on function search_conversations(text) from public, anon;
grant execute on function search_conversations(text) to authenticated, service_role;
