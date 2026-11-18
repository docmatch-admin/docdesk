-- 062: รายการแชทแบบคิวงาน (รอตอบ / งานค้าง / ล่าสุด)
-- 1) "AI ตอบแล้ว รอตรวจ": เวลาที่ AI ตอบเอง (โหมด auto/fallback) ล้างเมื่อเจ้าหน้าที่เปิดดูแชทหรือตอบเอง
alter table conversations add column if not exists ai_review_at timestamptz;
create index if not exists conversations_ai_review_idx on conversations (ai_review_at) where ai_review_at is not null;

-- 2) ค้นแชทด้วยเบอร์โทรด้วย (ชื่อ, HN, เบอร์, ข้อความ) — รวมแชทที่เสร็จแล้ว
create or replace function search_conversations(p_query text)
returns table (id uuid)
language sql stable
set search_path = public
as $$
  with q as (
    select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern,
           nullif(regexp_replace(p_query, '\D', '', 'g'), '') as digits
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
       select 1 from patient_links pl
       left join patients p on p.hn = pl.hn
       where pl.conversation_id = c.id
         and (pl.hn ilike q.pattern
           or (q.digits is not null and length(q.digits) >= 4
               and (regexp_replace(coalesce(pl.phone, ''), '\D', '', 'g') like '%' || q.digits || '%'
                 or regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || q.digits || '%')))
     )
     or exists (
       select 1 from messages m
       where m.conversation_id = c.id and (m.body ilike q.pattern or m.body_th ilike q.pattern)
     )
  order by c.last_message_at desc
  limit 200;
$$;

revoke all on function search_conversations(text) from public, anon;
grant execute on function search_conversations(text) to authenticated, service_role;
