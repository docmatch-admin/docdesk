-- แชทลับเรื่องเพศ: สิทธิ์บังคับที่ฐานข้อมูล ไม่ใช่แค่ซ่อนหน้าเว็บ
alter table conversations add column if not exists sensitive boolean not null default false;
alter table conversations add column if not exists sensitive_since timestamptz;
alter table conversations add column if not exists sensitive_reason text;
create index if not exists conversations_sensitive_idx on conversations (sensitive) where sensitive;

alter table staff add column if not exists can_view_sensitive boolean not null default false;
alter table staff add column if not exists sensitive_ack_at timestamptz;
update staff set can_view_sensitive = true where role = 'admin';

create or replace function staff_admin_views_sensitive() returns trigger
language plpgsql as $$
begin
  if new.role = 'admin' then new.can_view_sensitive := true; end if;
  return new;
end;
$$;
drop trigger if exists staff_admin_sensitive on staff;
create trigger staff_admin_sensitive before insert or update on staff
  for each row execute function staff_admin_views_sensitive();

create table if not exists sensitive_access_log (
  id bigserial primary key,
  staff_id uuid references staff(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  action text not null check (action in ('open', 'reveal', 'export', 'untag')),
  created_at timestamptz not null default now()
);
create index if not exists sensitive_access_log_time_idx on sensitive_access_log (created_at desc);
alter table sensitive_access_log enable row level security;
drop policy if exists admin_read on sensitive_access_log;
create policy admin_read on sensitive_access_log for select to authenticated using (is_admin());

-- ---------- ฟังก์ชันตรวจสิทธิ์ ----------
create or replace function can_view_sensitive_now() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff where id = auth.uid() and active and not must_change_password
      and (role = 'admin' or can_view_sensitive)
  );
$$;

create or replace function can_read_conversation(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_staff() and (
    can_view_sensitive_now()
    or not exists (select 1 from conversations where id = p_conversation and sensitive)
  );
$$;

create or replace function can_read_contact(p_contact uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_staff() and (
    can_view_sensitive_now()
    or not exists (select 1 from conversations where contact_id = p_contact and sensitive)
  );
$$;

-- ---------- RLS ----------
drop policy if exists staff_all on conversations;
drop policy if exists staff_access on conversations;
create policy staff_access on conversations for all to authenticated
  using (is_staff() and (not sensitive or can_view_sensitive_now()))
  with check (is_staff() and (not sensitive or can_view_sensitive_now()));

drop policy if exists staff_read on contacts;
create policy staff_read on contacts for select to authenticated using (can_read_contact(id));

do $$
declare t text;
begin
  foreach t in array array['messages', 'suggestions', 'bookings', 'assignment_log'] loop
    execute format('drop policy if exists staff_read on %I', t);
    execute format('create policy staff_read on %I for select to authenticated using (can_read_conversation(conversation_id))', t);
  end loop;
end $$;

-- รูปในแชทลับ: ขอ signed URL ไม่ได้ แม้รู้ path
create index if not exists messages_media_path_idx on messages (media_path) where media_path is not null;
create index if not exists messages_media_preview_idx on messages (media_preview_path) where media_preview_path is not null;
create or replace function media_is_sensitive(p_path text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from messages m join conversations c on c.id = m.conversation_id
    where c.sensitive and (m.media_path = p_path or m.media_preview_path = p_path)
  );
$$;
drop policy if exists staff_read_media on storage.objects;
create policy staff_read_media on storage.objects for select to authenticated
  using (bucket_id in ('chat-media', 'quick-media') and is_staff()
    and (can_view_sensitive_now() or not media_is_sensitive(name)));

-- หน้าเว็บแก้ conversations บางคอลัมน์ได้ จึงกันการปลดแชทลับเอง service role ผ่าน API ที่ตรวจสิทธิ์แล้ว
create or replace function guard_sensitive_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.sensitive is distinct from old.sensitive
    or new.sensitive_since is distinct from old.sensitive_since
    or new.sensitive_reason is distinct from old.sensitive_reason then
    raise exception 'ต้องจัดการแชทลับผ่าน API' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists conversations_guard_sensitive on conversations;
create trigger conversations_guard_sensitive before update on conversations
  for each row execute function guard_sensitive_update();

-- คนที่ไม่มีสิทธิ์เห็นแค่ว่ามีแชทลับรอตอบ ไม่มีชื่อ ข้อความ ภาษา หรือแท็ก และไม่มี id จริงให้เปิด
create or replace function masked_sensitive_waiting()
returns table (key text, waiting_since timestamptz)
language sql stable security definer set search_path = public as $$
  select md5(c.id::text), c.waiting_since
  from conversations c
  where is_staff() and not can_view_sensitive_now()
    and c.sensitive and c.status = 'open' and (c.last_direction = 'in' or c.booking_pending)
  order by c.waiting_since nulls last;
$$;
revoke all on function masked_sensitive_waiting() from public, anon;
grant execute on function masked_sensitive_waiting() to authenticated;

-- ---------- แท็กภายใน แสดงบนจอเป็น 🔒 ลับ ----------
insert into tags (name, color, "group", sort) values ('STD', '#c62d42', 'status', 999)
  on conflict (name) do nothing;

insert into settings (key, value) values
  ('sensitive_keywords', '["STD","ซิฟิลิส","หนองใน","เริม","หูดหงอนไก่","HIV","เอชไอวี","PEP","PrEP","เพร็พ","เป๊ป","ตรวจโรคติดต่อทางเพศ","โรคทางเพศ","ตกขาว","เสี่ยงมา","ถุงยางแตก","ถุงยางหลุด","มีเพศสัมพันธ์","มีอะไรกับ","หนองไหล","แผลที่อวัยวะเพศ","คันอวัยวะเพศ","VDRL","TPHA","CD4"]'),
  ('sensitive_media_retention_days', '30')
  on conflict (key) do nothing;

-- CSV: แชทลับไม่แสดงชื่อ และไม่แสดงแท็กอื่น
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
  select case when c.sensitive then '🔒 แชทลับ' else ct.display_name end, ch.type::text, e.tag, min(e.created_at)
  from tag_events e
  join latest l on l.conversation_id = e.conversation_id and l.tag = e.tag
  join conversations c on c.id = e.conversation_id
  join contacts ct on ct.id = c.contact_id
  join channels ch on ch.id = c.channel_id
  where e.action = 'add' and l.action = 'add' and e.created_at >= p_from and e.created_at < p_to
    and (p_tag is null or e.tag = p_tag)
    and (not c.sensitive or e.tag = 'STD')
  group by c.id, c.sensitive, ct.display_name, ch.type, e.tag
  order by min(e.created_at), e.tag, c.id;
$$;

-- ---------- แชทเดิมที่เข้าข่าย ----------
-- ปิดตัวอย่างคำตอบเดิมแทนการลบ ให้เจ้าของตัดสินใจเอง
do $$
declare
  v_ids uuid[];
begin
  select coalesce(array_agg(distinct m.conversation_id), '{}') into v_ids
  from messages m
  where m.direction = 'in' and (
    coalesce(m.body, '') || ' ' || coalesce(m.body_th, '') ~ '(ซิฟิลิส|หนองใน|เริม|หูดหงอนไก่|เอชไอวี|เพร็พ|เป๊ป|ตรวจโรคติดต่อทางเพศ|โรคทางเพศ|ตกขาว|เสี่ยงมา|ถุงยางแตก|ถุงยางหลุด|มีเพศสัมพันธ์|มีอะไรกับ|หนองไหล|แผลที่อวัยวะเพศ|คันอวัยวะเพศ)'
    or coalesce(m.body, '') || ' ' || coalesce(m.body_th, '') ~* '(^|[^a-z0-9])(std|hiv|pep|prep|vdrl|tpha|cd4)([^a-z0-9]|$)'
  );

  update conversations set sensitive = true, sensitive_since = now(), sensitive_reason = 'ตรวจย้อนหลัง', needs_human = true
    where id = any(v_ids);
  update conversations set tags = array_append(tags, 'STD') where id = any(v_ids) and not ('STD' = any(tags));
  insert into tag_events (conversation_id, tag, action, "by")
    select id, 'STD', 'add', 'rule' from unnest(v_ids) as id;
  update reply_examples set active = false
    where source_message_id in (select id from messages where conversation_id = any(v_ids));
end $$;
