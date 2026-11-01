-- แยกสิทธิ์ admin / agent และปิดบัญชีเจ้าหน้าที่ได้
alter table staff add column if not exists active boolean not null default true;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active);
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid() and active and role = 'admin');
$$;

-- ข้อมูลตั้งค่า: เจ้าหน้าที่อ่านได้ แก้ได้เฉพาะ admin
do $$
declare t text;
begin
  foreach t in array array['settings', 'channels', 'knowledge_items', 'reply_examples', 'tags', 'tag_rules'] loop
    execute format('drop policy if exists staff_all on %I', t);
    execute format('drop policy if exists staff_read on %I', t);
    execute format('drop policy if exists admin_write on %I', t);
    execute format('create policy staff_read on %I for select to authenticated using (is_staff())', t);
    execute format('create policy admin_write on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;

-- เขียนผ่าน server ด้วย service role เท่านั้น หน้าเว็บอ่านอย่างเดียว
do $$
declare t text;
begin
  foreach t in array array['staff', 'quick_media', 'messages', 'contacts', 'suggestions'] loop
    execute format('drop policy if exists staff_all on %I', t);
    execute format('drop policy if exists staff_read on %I', t);
    execute format('create policy staff_read on %I for select to authenticated using (is_staff())', t);
  end loop;
end $$;

-- รายงานรายละเอียด สถิติค่าใช้จ่าย และ error: เฉพาะ admin
do $$
declare t text;
begin
  foreach t in array array['tag_events', 'llm_usage_daily', 'system_errors'] loop
    execute format('drop policy if exists staff_read on %I', t);
    execute format('drop policy if exists admin_read on %I', t);
    execute format('create policy admin_read on %I for select to authenticated using (is_admin())', t);
  end loop;
end $$;

-- conversations: หน้าเว็บยังแก้ได้บางคอลัมน์ RLS กันรายคอลัมน์ไม่ได้ จึงใช้ trigger
-- auth.uid() เป็น null เมื่อเรียกด้วย service role ซึ่งผ่านการตรวจสิทธิ์ที่ API แล้ว
create or replace function guard_conversation_update() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.tags is distinct from old.tags then
    raise exception 'ต้องแก้แท็กผ่าน API' using errcode = '42501';
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    raise exception 'ต้องเปลี่ยนผู้ดูแลผ่าน API' using errcode = '42501';
  end if;
  if new.ai_mode is distinct from old.ai_mode and not is_admin() then
    raise exception 'เฉพาะ admin ที่เปลี่ยนโหมด AI ได้' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists conversations_guard_update on conversations;
create trigger conversations_guard_update
  before update on conversations
  for each row execute function guard_conversation_update();
