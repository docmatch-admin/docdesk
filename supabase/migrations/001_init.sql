-- =====================================================================
-- DocDesk — ระบบรวมแชททุกช่องทาง + AI ผู้ช่วยตอบ (คลินิกแรก: แฮปปี้เวลล์)
-- รันใน Supabase SQL Editor (หรือ supabase db push)
-- =====================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------- enums ----------
do $$ begin
  create type channel_type as enum ('line','web','facebook','instagram','whatsapp');
exception when duplicate_object then null; end $$;

-- off      = ปิด AI: เจ้าหน้าที่ตอบเอง (ยังเห็นประโยคแนะนำ)
-- assist   = ผู้ช่วย: AI ร่างคำตอบ เจ้าหน้าที่กดส่ง
-- fallback = คนตอบก่อน: ถ้าไม่มีใครตอบใน X นาที หรือนอกเวลาทำการ AI ตอบแทน
-- auto     = อัตโนมัติ: AI ตอบเองทันที (เฉพาะเรื่องที่ไม่ต้องใช้แพทย์)
do $$ begin
  create type ai_mode as enum ('off','assist','fallback','auto');
exception when duplicate_object then null; end $$;

-- ---------- staff ----------
create table if not exists staff (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'เจ้าหน้าที่',
  role text not null default 'agent' check (role in ('admin','agent')),
  created_at timestamptz not null default now()
);

-- ไม่สร้างเจ้าหน้าที่อัตโนมัติ (กันคนนอกสมัครผ่าน API แล้วเข้าถึงแชท)
-- เพิ่มเจ้าหน้าที่ด้วยมือ: สร้าง user ใน Authentication > Users ก่อน แล้วรัน
--   insert into staff (id, display_name, role)
--   select id, 'ชื่อเจ้าหน้าที่', 'admin' from auth.users where email = 'อีเมล@example.com';
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists handle_new_user();

-- ---------- settings (key/value) ----------
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('ai_mode', '"assist"'),
  ('fallback_minutes', '5'),
  -- 0=อาทิตย์ ... 6=เสาร์, เวลาไทย
  ('business_hours', '{
     "tz":"Asia/Bangkok",
     "days":{
       "1":["08:00","18:00"],"2":["08:00","18:00"],"3":["08:00","18:00"],
       "4":["08:00","18:00"],"5":["08:00","18:00"],
       "6":["08:00","12:00"],"0":["08:00","12:00"]}}'),
  ('clinic_profile', '{
     "name":"แฮปปี้เวลล์ คลินิกเวชกรรม (HappiWell Medical Clinic)",
     "tone":"สุภาพ เป็นกันเอง ลงท้ายด้วย ค่ะ อ่านง่ายสำหรับผู้สูงอายุ"}')
on conflict (key) do nothing;

-- ---------- channels ----------
create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  type channel_type not null,
  name text not null,
  ai_mode ai_mode,                 -- null = ใช้ค่าทั้งระบบ
  enabled boolean not null default true,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (type, name)
);

insert into channels (type, name) values
  ('line', 'LINE @p49clinic'),
  ('web',  'เว็บไซต์ happiwellclinic.com')
on conflict do nothing;

-- ---------- contacts ----------
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  external_id text not null,           -- LINE userId / web session id
  display_name text,
  avatar_url text,
  language text not null default 'th', -- ภาษาที่ลูกค้าใช้ล่าสุด (ISO 639-1)
  note text,
  created_at timestamptz not null default now(),
  unique (channel_id, external_id)
);

-- ---------- conversations ----------
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  channel_id uuid not null references channels(id) on delete cascade,
  status text not null default 'open' check (status in ('open','closed')),
  assigned_to uuid references staff(id) on delete set null,
  ai_mode ai_mode,                     -- null = ใช้ค่าของช่องทาง
  tags text[] not null default '{}',
  unread_count int not null default 0,
  needs_human boolean not null default false, -- AI ขอให้คนดูแล (อาการ/ยา/ไม่มั่นใจ)
  ai_due_at timestamptz,               -- โหมด fallback: เวลาที่ AI จะตอบแทน
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  created_at timestamptz not null default now(),
  unique (contact_id)
);
create index if not exists conversations_last_idx on conversations (last_message_at desc);
create index if not exists conversations_due_idx on conversations (ai_due_at) where ai_due_at is not null;

-- ---------- messages ----------
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  sender_type text not null check (sender_type in ('customer','staff','ai','system')),
  sender_id uuid references staff(id) on delete set null,
  body text not null,                  -- ข้อความจริงที่ลูกค้าเห็น/พิมพ์
  body_th text,                        -- ฉบับภาษาไทยสำหรับเจ้าหน้าที่ (null = เป็นไทยอยู่แล้ว)
  language text not null default 'th',
  external_id text,
  starred boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages (conversation_id, created_at);

-- ---------- ฐานข้อมูลคลินิก (แหล่งที่ 1) ----------
create table if not exists knowledge_items (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'ทั่วไป',
  title text not null,
  content text not null,
  active boolean not null default true,
  embedding vector(1536),
  updated_by uuid references staff(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- ---------- คำตอบเดิมของเจ้าหน้าที่ (แหล่งที่ 2) ----------
create table if not exists reply_examples (
  id uuid primary key default gen_random_uuid(),
  question text not null,              -- คำถามลูกค้า (ไทย, ตัดข้อมูลส่วนตัวแล้ว)
  answer text not null,                -- คำตอบเจ้าหน้าที่ (ไทย, ตัดข้อมูลส่วนตัวแล้ว)
  embedding vector(1536),
  starred boolean not null default false,   -- กดดาว = คำตอบมาตรฐาน
  use_count int not null default 0,         -- ถูกเลือกจากคำแนะนำกี่ครั้ง
  source_message_id uuid references messages(id) on delete set null,
  created_by uuid references staff(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- log คำแนะนำ (ใช้เรียนรู้ว่าเลือก/แก้/ไม่ใช้) ----------
create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  trigger_message_id uuid references messages(id) on delete set null,
  options jsonb not null,              -- [{text, source, ref_ids, confidence}]
  needs_human boolean not null default false,
  chosen_index int,                    -- null = ไม่ได้ใช้
  edited boolean,
  created_at timestamptz not null default now()
);
create index if not exists suggestions_conv_idx on suggestions (conversation_id, created_at desc);

-- ---------- vector search ----------
create index if not exists knowledge_embedding_idx on knowledge_items
  using hnsw (embedding vector_cosine_ops);
create index if not exists examples_embedding_idx on reply_examples
  using hnsw (embedding vector_cosine_ops);

create or replace function match_knowledge(query_embedding vector(1536), match_count int default 5)
returns table (id uuid, category text, title text, content text, updated_at timestamptz, similarity float)
language sql stable as $$
  select k.id, k.category, k.title, k.content, k.updated_at,
         1 - (k.embedding <=> query_embedding) as similarity
  from knowledge_items k
  where k.active and k.embedding is not null
  order by k.embedding <=> query_embedding
  limit match_count;
$$;

-- คำตอบดาว + ถูกใช้บ่อย ได้คะแนนเพิ่มเล็กน้อย
create or replace function match_examples(query_embedding vector(1536), match_count int default 5)
returns table (id uuid, question text, answer text, starred boolean, use_count int,
               created_at timestamptz, similarity float, score float)
language sql stable as $$
  select * from (
    select e.id, e.question, e.answer, e.starred, e.use_count, e.created_at,
           1 - (e.embedding <=> query_embedding) as similarity,
           (1 - (e.embedding <=> query_embedding))
             + case when e.starred then 0.05 else 0 end
             + least(e.use_count, 20) * 0.002 as score
    from reply_examples e
    where e.active and e.embedding is not null
    order by e.embedding <=> query_embedding
    limit match_count * 3
  ) c
  order by c.score desc
  limit match_count;
$$;

create or replace function increment_example_use(example_ids uuid[])
returns void language sql as $$
  update reply_examples set use_count = use_count + 1 where id = any(example_ids);
$$;

-- ---------- RLS: เจ้าหน้าที่ที่ล็อกอิน (มีแถวใน staff) เข้าถึงได้ทั้งหมด ----------
create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where id = auth.uid());
$$;

do $$
declare t text;
begin
  foreach t in array array['staff','settings','channels','contacts','conversations',
                           'messages','knowledge_items','reply_examples','suggestions']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists staff_all on %I', t);
    execute format('create policy staff_all on %I for all to authenticated using (is_staff()) with check (is_staff())', t);
  end loop;
end $$;
-- หมายเหตุ: webhook/web chat ใช้ service role ฝั่ง server (ข้าม RLS)

-- ---------- realtime ----------
do $$ begin
  alter publication supabase_realtime add table messages, conversations, suggestions;
exception when others then null; end $$;
