-- ชื่อคนไข้หลังผูก HN: ชื่อจาก iService (HIS) แสดงเป็น "{ชื่อ นามสกุล} · HN {hn}" ทุกที่
-- ลำดับความสำคัญ his > staff > ai > platform
--   display_name     = ชื่อที่ไม่ใช่ HIS (เจ้าหน้าที่ตั้ง / AI จับได้ / ชื่อจากแพลตฟอร์ม) ใช้กลับมาเมื่อยกเลิกการผูก
--   platform_name    = ชื่อ LINE/Facebook/Instagram ล่าสุด แสดงเป็นบรรทัดเล็กและค้นหาได้
--   patient_full_name, hn = จาก HIS เมื่อผูกแล้ว
alter table contacts
  add column if not exists platform_name text,
  add column if not exists hn text,
  add column if not exists patient_full_name text,
  add column if not exists name_source text not null default 'platform';

alter table contacts drop constraint if exists contacts_name_source_check;
alter table contacts add constraint contacts_name_source_check check (name_source in ('his', 'staff', 'ai', 'platform'));

update contacts set platform_name = display_name where platform_name is null and not name_locked;
update contacts set name_source = 'staff' where name_locked and name_source = 'platform';
create index if not exists contacts_hn_idx on contacts (hn) where hn is not null;

-- ชื่อในนัดมาจาก iService (เลือกจาก visit/ค้นหา และไม่ได้แก้) ใช้เป็นชื่อ HIS ได้ถ้าเรียก iService ไม่ได้ตอนผูก
alter table appointments add column if not exists name_from_his boolean not null default false;

-- ประวัติการผูก/ยกเลิกการผูก HN
create table if not exists patient_link_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  hn text not null,
  action text not null check (action in ('link', 'unlink')),
  via text not null check (via in ('link_code', 'staff')),
  name_source text,
  staff_id uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists patient_link_events_conversation_idx on patient_link_events (conversation_id, created_at);
alter table patient_link_events enable row level security;
revoke all on patient_link_events from anon, authenticated;
grant select on patient_link_events to authenticated;
drop policy if exists admin_read on patient_link_events;
create policy admin_read on patient_link_events for select to authenticated using (is_admin());

-- ค้นหาด้วยชื่อ HIS, HN และชื่อแพลตฟอร์มได้ด้วย
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
     or ct.platform_name ilike q.pattern
     or ct.patient_full_name ilike q.pattern
     or ct.hn ilike q.pattern
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
