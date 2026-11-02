-- ราคาบริการจากเว็บ: แถว source = website แก้ได้จากการซิงก์เท่านั้น
alter table knowledge_items add column if not exists source text not null default 'manual';
alter table knowledge_items add column if not exists website_slug text;

alter table knowledge_items drop constraint if exists knowledge_items_source_check;
alter table knowledge_items add constraint knowledge_items_source_check check (source in ('manual', 'website'));
alter table knowledge_items drop constraint if exists knowledge_items_website_slug_key;
alter table knowledge_items add constraint knowledge_items_website_slug_key unique (website_slug);

-- หน้าเว็บเขียนตารางนี้ตรงได้ จึงต้องกันที่ฐานข้อมูล auth.uid() เป็น null เมื่อเรียกด้วย service role
create or replace function guard_website_knowledge() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if (tg_op <> 'INSERT' and old.source = 'website') or (tg_op <> 'DELETE' and new.source = 'website') then
    raise exception 'ข้อมูลจากเว็บ ต้องแก้ที่หลังบ้านเว็บ' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists knowledge_guard_website on knowledge_items;
create trigger knowledge_guard_website
  before insert or update or delete on knowledge_items
  for each row execute function guard_website_knowledge();
