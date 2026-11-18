-- 063: รายการแชทแบบคิวงานคำนวณในฐานข้อมูล (แทนการคำนวณทุกครั้งที่เปิดหน้า)
-- conversations.queue = 'waiting' | 'work' | 'recent' + ป้ายงานค้าง (work_kind / work_label / work_since) + sort_key
-- อัปเดตอัตโนมัติด้วย trigger เมื่อ conversations / bookings / appointments / chat_tasks / lab_results / patient_links เปลี่ยน
-- กติกาเดียวกับ src/lib/inbox-work.ts + src/lib/case-flow.ts (sectionOf, WORK_PRIORITY, workLabel)
-- รวมของ 062 ไว้แล้ว (รันไฟล์นี้ไฟล์เดียวได้ ถ้ารัน 062 ไปแล้วก็รันซ้ำได้)

-- ---------- 1) คอลัมน์ ----------
alter table conversations add column if not exists ai_review_at timestamptz;
alter table conversations add column if not exists queue text not null default 'recent';
alter table conversations add column if not exists work_kind text;
alter table conversations add column if not exists work_label text;
alter table conversations add column if not exists work_since timestamptz;
alter table conversations add column if not exists sort_key timestamptz;
-- แตะเมื่องานค้างจากตารางอื่นเปลี่ยน → trigger คำนวณช่วงใหม่
alter table conversations add column if not exists queue_touch_at timestamptz;
do $$ begin
  alter table conversations add constraint conversations_queue_check check (queue in ('waiting', 'work', 'recent'));
exception when duplicate_object then null; end $$;

-- ---------- 2) index ----------
-- รายการแชท: แต่ละช่วงเรียงตาม sort_key (รอตอบ/งานค้าง เก่าสุดก่อน · ล่าสุด ใหม่สุดก่อน)
create index if not exists conversations_queue_sort_idx on conversations (queue, sort_key, id);
-- badge = นับรอตอบ + งานค้าง (แถวน้อย ใช้ partial index)
create index if not exists conversations_queue_waiting_idx on conversations (sort_key) where queue = 'waiting';
create index if not exists conversations_queue_work_idx on conversations (sort_key) where queue = 'work';
create index if not exists conversations_ai_review_idx on conversations (ai_review_at) where ai_review_at is not null;
-- งานค้างต่อแชท
create index if not exists bookings_pending_idx on bookings (conversation_id) where status = 'ai_confirmed';
create index if not exists chat_tasks_open_idx on chat_tasks (conversation_id) where not done;
create index if not exists lab_results_failed_idx on lab_results (patient_id) where notify_status = 'failed';
create index if not exists appointments_open_uncalled_idx on appointments (hn, appoint_date) where called_at is null;

-- ---------- 3) ฟังก์ชันช่วย ----------
-- เหมือน hnVariants(): "4141" ↔ "000004141"
create or replace function hn_variants(p_hn text)
returns text[] language sql immutable as $$
  select case
    when p_hn is null or btrim(p_hn) = '' then array[]::text[]
    when btrim(p_hn) !~ '^\d+$' then array[btrim(p_hn)]
    else array(select distinct v from unnest(array[
      btrim(p_hn),
      coalesce(nullif(ltrim(btrim(p_hn), '0'), ''), '0'),
      lpad(coalesce(nullif(ltrim(btrim(p_hn), '0'), ''), '0'), 9, '0')
    ]) v)
  end
$$;

-- "2026-11-19" → "19 พ.ย." (เหมือน shortThaiDate)
create or replace function thai_short_date(p_date date)
returns text language sql immutable as $$
  select case when p_date is null then null else
    extract(day from p_date)::int || ' ' ||
    (array['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'])[extract(month from p_date)::int]
  end
$$;

-- ---------- 4) คำนวณช่วงของแชท 1 แชท ----------
-- รอตอบ = เปิดอยู่และข้อความล่าสุดมาจากลูกค้า (ไม่ต้องดูงานค้าง) · มีงานค้าง = งานค้าง · นอกนั้น = ล่าสุด
-- งานที่ด่วนสุดเป็นป้าย: ยืนยันนัด → ขอเลื่อนนัด → ส่งไม่สำเร็จ → งานทีม → AI ตอบแล้ว รอตรวจ
create or replace function conversation_queue_of(
  p_id uuid, p_status text, p_last_direction text, p_archived boolean, p_ai_review_at timestamptz,
  p_waiting_since timestamptz, p_last_inbound_at timestamptz, p_last_message_at timestamptz,
  out queue text, out work_kind text, out work_label text, out work_since timestamptz, out sort_key timestamptz)
language plpgsql stable security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Bangkok')::date;
  hns text[];
  b_since timestamptz; b_date date; b_time time;
  r_since timestamptz; r_date date;
  f_since timestamptz;
  t_since timestamptz; t_count int;
begin
  if p_status = 'open' and p_last_direction = 'in' then
    queue := 'waiting';
    sort_key := coalesce(p_waiting_since, p_last_inbound_at, p_last_message_at);
    return;
  end if;

  -- ยืนยันนัด: นัดที่ AI รับไว้/คนไข้ขอ ที่ยังไม่ลงนัด (แสดงวันเวลาที่ใกล้สุด)
  select min(b.created_at) into b_since from bookings b where b.conversation_id = p_id and b.status = 'ai_confirmed';
  if b_since is not null then
    select b."date", b."time" into b_date, b_time from bookings b
      where b.conversation_id = p_id and b.status = 'ai_confirmed' order by b."date", b."time" limit 1;
  end if;

  -- นัด/ผลแล็บผูกกับแชทผ่าน conversation_id ของนัด และทุก HN ที่ผูกกับแชทนี้
  select coalesce(array_agg(distinct v), array[]::text[]) into hns
    from patient_links pl, unnest(hn_variants(pl.hn)) v where pl.conversation_id = p_id;

  -- ขอเลื่อนนัด (ยังไม่ได้โทร) · ส่งไม่สำเร็จ (ข้อความนัดส่งไม่ถึง)
  select min(a.updated_at) filter (where a.status = 'reschedule_requested'),
         min(nullif(a.reschedule_request->>'date', '')::date) filter (where a.status = 'reschedule_requested'),
         min(a.updated_at) filter (where a.status <> 'reschedule_requested' and a.last_send_error is not null)
    into r_since, r_date, f_since
    from appointments a
   where (a.conversation_id = p_id or a.hn = any(hns))
     and a.appoint_date >= today
     and a.status in ('scheduled', 'confirmed', 'reschedule_requested')
     and a.called_at is null
     and (a.status = 'reschedule_requested' or a.last_send_error is not null);

  -- ผลแล็บส่ง LINE ไม่สำเร็จ
  if cardinality(hns) > 0 then
    select least(f_since, min(l.updated_at)) into f_since
      from lab_results l where l.notify_status = 'failed' and l.patient_id = any(hns);
  end if;

  -- งานทีมที่ยังไม่เสร็จ
  select min(t.created_at), count(*) into t_since, t_count from chat_tasks t where t.conversation_id = p_id and not t.done;

  work_since := least(b_since, r_since, f_since, case when t_count > 0 then t_since end, p_ai_review_at);
  if b_since is not null then
    work_kind := 'booking';
    work_label := 'ยืนยันนัด' || coalesce(' ' || thai_short_date(b_date) || coalesce(' ' || to_char(b_time, 'HH24:MI'), ''), '');
  elsif r_since is not null then
    work_kind := 'reschedule';
    work_label := 'ขอเลื่อนนัด' || coalesce(' → ' || thai_short_date(r_date), '');
  elsif f_since is not null then
    work_kind := 'failed';
    work_label := 'ส่งไม่สำเร็จ';
  elsif t_count > 0 then
    work_kind := 'tasks';
    work_label := 'งานทีม ' || t_count;
  elsif p_ai_review_at is not null then
    work_kind := 'ai_review';
    work_label := 'AI ตอบแล้ว รอตรวจ';
  end if;

  if work_kind is not null then
    queue := 'work';
    sort_key := work_since;
  else
    queue := 'recent';
    sort_key := p_last_message_at;
  end if;
end
$$;

-- ---------- 5) trigger บน conversations: คำนวณลงแถวเดียวกันก่อนบันทึก (realtime ส่งช่วงใหม่ไปพร้อมแถว) ----------
create or replace function conversations_queue_trigger()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare r record;
begin
  select * into r from conversation_queue_of(new.id, new.status, new.last_direction, new.archived, new.ai_review_at,
    new.waiting_since, new.last_inbound_at, new.last_message_at);
  new.queue := r.queue;
  new.work_kind := r.work_kind;
  new.work_label := r.work_label;
  new.work_since := r.work_since;
  new.sort_key := r.sort_key;
  return new;
end
$$;

drop trigger if exists conversations_queue_ins on conversations;
create trigger conversations_queue_ins before insert on conversations
  for each row execute function conversations_queue_trigger();
drop trigger if exists conversations_queue_upd on conversations;
-- เฉพาะฟิลด์ที่มีผลต่อช่วง (อ่านแล้ว/แท็ก/ผู้ดูแล ไม่ต้องคำนวณใหม่) · queue_touch_at = งานค้างจากตารางอื่นเปลี่ยน
create trigger conversations_queue_upd before update on conversations
  for each row when (
    old.status is distinct from new.status
    or old.last_direction is distinct from new.last_direction
    or old.archived is distinct from new.archived
    or old.ai_review_at is distinct from new.ai_review_at
    or old.waiting_since is distinct from new.waiting_since
    or old.last_inbound_at is distinct from new.last_inbound_at
    or old.last_message_at is distinct from new.last_message_at
    or old.queue_touch_at is distinct from new.queue_touch_at
  ) execute function conversations_queue_trigger();

-- คำนวณใหม่ (เขียนเฉพาะเมื่อผลเปลี่ยน ไม่อย่างนั้น realtime ยิงไปทุกเครื่องโดยไม่จำเป็น)
create or replace function refresh_conversation_queue(p_id uuid)
returns void language plpgsql
set search_path = public
as $$
declare c conversations%rowtype; r record;
begin
  if p_id is null then return; end if;
  select * into c from conversations where id = p_id;
  if not found then return; end if;
  select * into r from conversation_queue_of(c.id, c.status, c.last_direction, c.archived, c.ai_review_at,
    c.waiting_since, c.last_inbound_at, c.last_message_at);
  if (c.queue, c.work_kind, c.work_label, c.work_since, c.sort_key) is distinct from (r.queue, r.work_kind, r.work_label, r.work_since, r.sort_key) then
    update conversations set queue_touch_at = now() where id = p_id;
  end if;
end
$$;

-- ทุกแชทที่ผูกกับ HN นี้ (นัด/ผลแล็บผูกผ่าน HN)
create or replace function refresh_conversation_queue_for_hn(p_hn text)
returns void language plpgsql
set search_path = public
as $$
declare cid uuid;
begin
  if p_hn is null or btrim(p_hn) = '' then return; end if;
  for cid in select distinct conversation_id from patient_links where hn = any(hn_variants(p_hn)) loop
    perform refresh_conversation_queue(cid);
  end loop;
end
$$;

-- ---------- 6) trigger บนตารางที่เป็นที่มาของงานค้าง ----------
create or replace function queue_source_trigger()
returns trigger language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name in ('bookings', 'chat_tasks', 'patient_links') then
    if tg_op <> 'DELETE' then perform refresh_conversation_queue(new.conversation_id); end if;
    if tg_op <> 'INSERT' and (tg_op = 'DELETE' or old.conversation_id is distinct from new.conversation_id) then
      perform refresh_conversation_queue(old.conversation_id);
    end if;
  elsif tg_table_name = 'appointments' then
    if tg_op <> 'DELETE' then
      perform refresh_conversation_queue(new.conversation_id);
      perform refresh_conversation_queue_for_hn(new.hn);
    end if;
    if tg_op <> 'INSERT' and (tg_op = 'DELETE' or old.hn is distinct from new.hn or old.conversation_id is distinct from new.conversation_id) then
      perform refresh_conversation_queue(old.conversation_id);
      perform refresh_conversation_queue_for_hn(old.hn);
    end if;
  elsif tg_table_name = 'lab_results' then
    if tg_op <> 'DELETE' then perform refresh_conversation_queue_for_hn(new.patient_id); end if;
    if tg_op <> 'INSERT' and (tg_op = 'DELETE' or old.patient_id is distinct from new.patient_id) then
      perform refresh_conversation_queue_for_hn(old.patient_id);
    end if;
  end if;
  return null;
end
$$;

drop trigger if exists bookings_queue on bookings;
create trigger bookings_queue after insert or delete or update of status, "date", "time", conversation_id on bookings
  for each row execute function queue_source_trigger();
drop trigger if exists chat_tasks_queue on chat_tasks;
create trigger chat_tasks_queue after insert or delete or update of done, conversation_id on chat_tasks
  for each row execute function queue_source_trigger();
drop trigger if exists patient_links_queue on patient_links;
create trigger patient_links_queue after insert or delete or update of hn, conversation_id on patient_links
  for each row execute function queue_source_trigger();
drop trigger if exists appointments_queue on appointments;
create trigger appointments_queue after insert or delete or update of status, called_at, last_send_error, reschedule_request, appoint_date, hn, conversation_id on appointments
  for each row execute function queue_source_trigger();
drop trigger if exists lab_results_queue on lab_results;
create trigger lab_results_queue after insert or delete or update of notify_status, patient_id on lab_results
  for each row execute function queue_source_trigger();

-- ---------- 7) วันเปลี่ยน: นัดที่ผ่านวันแล้วไม่นับเป็นงานค้าง → คำนวณแชทในช่วงงานค้างใหม่ทุกคืน ----------
create or replace function refresh_work_queues()
returns int language plpgsql
set search_path = public
as $$
declare cid uuid; n int := 0;
begin
  for cid in select id from conversations where queue = 'work' loop
    perform refresh_conversation_queue(cid);
    n := n + 1;
  end loop;
  return n;
end
$$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('inbox-queue-daily', '5 17 * * *', 'select refresh_work_queues()'); -- 00:05 เวลาไทย
  end if;
end $$;

revoke all on function refresh_conversation_queue(uuid), refresh_conversation_queue_for_hn(text), refresh_work_queues(),
  conversation_queue_of(uuid, text, text, boolean, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- ---------- 8) backfill ----------
-- แตะ queue_touch_at ให้ trigger คำนวณทุกแถว (ครั้งเดียว)
update conversations set queue_touch_at = now();

-- ---------- 9) ค้นหา: ชื่อ, HN, เบอร์, ข้อความ, แท็ก — รวมแชทที่เสร็จแล้ว ----------
-- เดิม (062) เป็น OR ข้ามหลายตาราง → ฐานข้อมูลต้องไล่ทุกแชท × ทุกข้อความ
-- ใหม่: แยกหาแต่ละแหล่งด้วย trigram index แล้วรวม id (UNION) — ผลเหมือนเดิม
create extension if not exists pg_trgm with schema extensions;
create index if not exists contacts_display_name_trgm on contacts using gin (display_name extensions.gin_trgm_ops);
create index if not exists contacts_platform_name_trgm on contacts using gin (platform_name extensions.gin_trgm_ops);
create index if not exists contacts_patient_full_name_trgm on contacts using gin (patient_full_name extensions.gin_trgm_ops);
create index if not exists contacts_hn_trgm on contacts using gin (hn extensions.gin_trgm_ops);
create index if not exists conversations_preview_trgm on conversations using gin (last_message_preview extensions.gin_trgm_ops);
create index if not exists messages_body_trgm on messages using gin (body extensions.gin_trgm_ops);
create index if not exists messages_body_th_trgm on messages using gin (body_th extensions.gin_trgm_ops);
create index if not exists patient_links_hn_trgm on patient_links using gin (hn extensions.gin_trgm_ops);

create or replace function search_conversations(p_query text)
returns table (id uuid)
language sql stable
set search_path = public, extensions
as $$
  with q as (
    select '%' || replace(replace(replace(trim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern,
           nullif(regexp_replace(p_query, '\D', '', 'g'), '') as digits
  ),
  hits as (
    select c.id from conversations c join contacts ct on ct.id = c.contact_id, q
     where ct.display_name ilike q.pattern or ct.platform_name ilike q.pattern
        or ct.patient_full_name ilike q.pattern or ct.hn ilike q.pattern
    union
    select c.id from conversations c, q
     where c.last_message_preview ilike q.pattern or exists (select 1 from unnest(c.tags) t where t ilike q.pattern)
    union
    select pl.conversation_id from patient_links pl left join patients p on p.hn = pl.hn, q
     where pl.hn ilike q.pattern
        or (q.digits is not null and length(q.digits) >= 4
            and (regexp_replace(coalesce(pl.phone, ''), '\D', '', 'g') like '%' || q.digits || '%'
              or regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') like '%' || q.digits || '%'))
    union
    select m.conversation_id from messages m, q
     where m.body ilike q.pattern or m.body_th ilike q.pattern
  )
  select c.id from conversations c
   where c.id in (select h.id from hits h)
   order by c.last_message_at desc
   limit 200;
$$;

revoke all on function search_conversations(text) from public, anon;
grant execute on function search_conversations(text) to authenticated, service_role;
