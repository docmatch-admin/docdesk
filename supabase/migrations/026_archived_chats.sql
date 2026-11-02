-- แชทเก็บถาวรจากประวัติ LINE OA: อ่านได้ ส่งไม่ได้ รอรวมเมื่อลูกค้ากลับมา
alter table conversations add column if not exists archived boolean not null default false;
alter table conversations add column if not exists archive_merged_at timestamptz;
create index if not exists conversations_archived_idx on conversations (archived) where archived;

-- id ของ chat.line.biz ใช้ส่งข้อความไม่ได้ จึงไม่เก็บใน external_id ซึ่ง webhook ใช้จับคู่
alter table contacts add column if not exists line_oa_chat_id text unique;
alter table messages add column if not exists line_oa_chat_id text;

-- "ไม่ใช่คนเดียวกัน" ไม่ถามอีก ใช้ชื่อห้องเดิมได้แม้แยกกลับมาใหม่
create table if not exists archive_merge_dismissed (
  conversation_id uuid not null references conversations(id) on delete cascade,
  archived_conversation_id uuid not null references conversations(id) on delete cascade,
  dismissed_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, archived_conversation_id)
);
alter table archive_merge_dismissed enable row level security;

-- แถวต้นทางถูกลบเมื่อรวม จึงเก็บเป็นข้อความ
create table if not exists archive_merge_log (
  id bigserial primary key,
  action text not null check (action in ('merge', 'dismiss', 'split')),
  conversation_id uuid references conversations(id) on delete set null,
  line_oa_chat_id text,
  messages integer not null default 0,
  staff_id uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table archive_merge_log enable row level security;
drop policy if exists admin_read on archive_merge_log;
create policy admin_read on archive_merge_log for select to authenticated using (is_admin());

create or replace function guard_archived_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.archived is distinct from old.archived then
    raise exception 'ต้องจัดการแชทเก่าผ่าน API' using errcode = '42501';
  end if;
  if old.archived and new.status is distinct from old.status then
    raise exception 'แชทเก่าเปิดใหม่ไม่ได้' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists conversations_guard_archived on conversations;
create trigger conversations_guard_archived before update on conversations
  for each row execute function guard_archived_update();

create or replace function masked_sensitive_waiting()
returns table (key text, waiting_since timestamptz)
language sql stable security definer set search_path = public as $$
  select md5(c.id::text), c.waiting_since
  from conversations c
  where is_staff() and not can_view_sensitive_now()
    and c.sensitive and not c.archived and c.status = 'open' and (c.last_direction = 'in' or c.booking_pending)
  order by c.waiting_since nulls last;
$$;
