-- เนื้อหาหน้าเว็บและบทความ (source = website_page) ซิงก์จากเว็บคลินิก แก้ได้จากการซิงก์เท่านั้นเหมือนราคา
alter table knowledge_items drop constraint if exists knowledge_items_source_check;
alter table knowledge_items add constraint knowledge_items_source_check check (source in ('manual', 'website', 'website_page'));

create or replace function guard_website_knowledge() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return coalesce(new, old);
  end if;
  if (tg_op <> 'INSERT' and old.source in ('website', 'website_page'))
     or (tg_op <> 'DELETE' and new.source in ('website', 'website_page')) then
    raise exception 'ข้อมูลจากเว็บ ต้องแก้ที่หลังบ้านเว็บ' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
