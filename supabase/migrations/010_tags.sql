-- ระบบแท็ก: ใช้ conversations.tags เดิม เก็บชื่อแท็ก จึงไม่เปิดให้เปลี่ยนชื่อแท็ก
create table if not exists tags (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 40),
  color text not null default '#4a63e0' check (color ~ '^#[0-9a-fA-F]{6}$'),
  "group" text not null default 'topic' check ("group" in ('topic', 'status', 'customer')),
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into tags (name, color, "group", sort) values
  ('วัคซีน', '#4a63e0', 'topic', 10),
  ('ตรวจสุขภาพ', '#22a06b', 'topic', 20),
  ('ใบรับรองแพทย์', '#0891b2', 'topic', 30),
  ('ตรวจรักษา', '#7c3aed', 'topic', 40),
  ('สิทธิ/ประกัน', '#c2740a', 'topic', 50),
  ('B2B บริษัท', '#475569', 'topic', 60),
  ('รอนัด', '#d97706', 'status', 10),
  ('นัดแล้ว', '#16a34a', 'status', 20),
  ('ตามต่อ', '#2563eb', 'status', 30),
  ('ร้องเรียน', '#dc2626', 'status', 40),
  ('ต่างชาติ', '#db2777', 'customer', 10),
  ('ลูกค้าประจำ', '#0d9488', 'customer', 20)
on conflict (name) do nothing;

create table if not exists tag_events (
  id bigserial primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  tag text not null,
  action text not null check (action in ('add', 'remove')),
  "by" text not null check ("by" in ('staff', 'ai', 'rule')),
  created_at timestamptz not null default now()
);
create index if not exists tag_events_report_idx on tag_events (created_at, tag);
create index if not exists tag_events_conv_idx on tag_events (conversation_id, tag, created_at desc);

-- kind = non_thai หมายถึงข้อความที่ไม่ใช่ภาษาไทย ไม่ใช้ keyword
create table if not exists tag_rules (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'keyword' check (kind in ('keyword', 'non_thai')),
  keyword text not null default '',
  tag text not null,
  created_at timestamptz not null default now()
);

insert into tag_rules (kind, keyword, tag)
select * from (values
  ('keyword', 'บริษัท|พนักงาน|โรงงาน', 'B2B บริษัท'),
  ('non_thai', '', 'ต่างชาติ')
) as seed(kind, keyword, tag)
where not exists (select 1 from tag_rules);

alter table suggestions add column if not exists suggested_tags text[] not null default '{}';

-- กรองแชทตามแท็กที่ฝั่งฐานข้อมูล ไม่จำกัดแค่แชทล่าสุดที่โหลดมา
create index if not exists conversations_tags_idx on conversations using gin (tags);

alter table tags enable row level security;
alter table tag_events enable row level security;
alter table tag_rules enable row level security;
drop policy if exists staff_all on tags;
create policy staff_all on tags for all to authenticated using (is_staff()) with check (is_staff());
drop policy if exists staff_all on tag_rules;
create policy staff_all on tag_rules for all to authenticated using (is_staff()) with check (is_staff());
drop policy if exists staff_read on tag_events;
create policy staff_read on tag_events for select to authenticated using (is_staff());

-- ติด/เอาแท็กออกแบบ atomic และบันทึก event เฉพาะเมื่อเปลี่ยนจริง
-- ถ้าเจ้าหน้าที่เคยเอาแท็กนี้ออกจากแชทนี้ กฎและ AI จะไม่ติดกลับให้
create or replace function set_conversation_tag(p_conversation uuid, p_tag text, p_action text, p_by text)
returns text[]
language plpgsql
set search_path = public
as $$
declare
  v_tags text[];
begin
  if p_action = 'add' then
    if p_by = 'staff' or not exists (
      select 1 from tag_events
      where conversation_id = p_conversation and tag = p_tag and action = 'remove' and "by" = 'staff'
    ) then
      update conversations set tags = array_append(tags, p_tag)
        where id = p_conversation and not (p_tag = any(tags));
      if found then
        insert into tag_events (conversation_id, tag, action, "by") values (p_conversation, p_tag, 'add', p_by);
      end if;
    end if;
  elsif p_action = 'remove' then
    update conversations set tags = array_remove(tags, p_tag)
      where id = p_conversation and p_tag = any(tags);
    if found then
      insert into tag_events (conversation_id, tag, action, "by") values (p_conversation, p_tag, 'remove', p_by);
    end if;
  else
    raise exception 'invalid action %', p_action;
  end if;
  select tags into v_tags from conversations where id = p_conversation;
  return v_tags;
end;
$$;
revoke all on function set_conversation_tag(uuid, text, text, text) from public, anon, authenticated;
grant execute on function set_conversation_tag(uuid, text, text, text) to service_role;

-- รายงาน: นับแชทที่ถูกติดแท็กในแต่ละช่วง ไม่นับคู่แชท-แท็กที่สุดท้ายถูกเอาออก (เช่น ติดผิด)
-- ใช้สิทธิ์ของผู้เรียก จึงอยู่ภายใต้ RLS ของ tag_events
create or replace function tag_report(p_unit text, p_from timestamptz, p_to timestamptz)
returns table (bucket text, tag text, chats bigint)
language sql stable
set search_path = public
as $$
  with latest as (
    select distinct on (conversation_id, tag) conversation_id, tag, action
    from tag_events
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

-- รายชื่อสำหรับส่งออก: มีเฉพาะชื่อที่แสดง ช่องทาง แท็ก และวันที่ ไม่มีเนื้อหาแชท
create or replace function tag_report_chats(p_tag text, p_from timestamptz, p_to timestamptz)
returns table (display_name text, channel text, tag text, tagged_at timestamptz)
language sql stable
set search_path = public
as $$
  with latest as (
    select distinct on (conversation_id, tag) conversation_id, tag, action
    from tag_events
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

revoke all on function tag_report(text, timestamptz, timestamptz) from public, anon;
revoke all on function tag_report_chats(text, timestamptz, timestamptz) from public, anon;
grant execute on function tag_report(text, timestamptz, timestamptz) to authenticated, service_role;
grant execute on function tag_report_chats(text, timestamptz, timestamptz) to authenticated, service_role;
