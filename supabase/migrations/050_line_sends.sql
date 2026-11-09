-- บันทึกทุกการส่ง LINE ว่าเป็น reply (ฟรี) หรือ push (นับโควตา) ใช้สรุปการใช้โควตารายเดือน
create table if not exists line_sends (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  conversation_id uuid references conversations(id) on delete set null,
  mode text not null check (mode in ('reply', 'push')),
  kind text not null check (kind in ('chat', 'appointment', 'reminder', 'broadcast')),
  -- จำนวนข้อความ (บับเบิล) ในคำขอนี้ LINE นับโควตา push ต่อข้อความ
  message_count int not null check (message_count between 1 and 5),
  ok boolean not null,
  -- push นี้เกิดจาก reply ไม่สำเร็จ (token หมดอายุ/ใช้ไปแล้ว)
  fallback boolean not null default false,
  token_age_ms int,
  error text check (char_length(error) <= 300)
);
create index if not exists line_sends_created_idx on line_sends (created_at desc);
alter table line_sends enable row level security;
drop policy if exists line_sends_admin_read on line_sends;
create policy line_sends_admin_read on line_sends for select to authenticated using (is_admin());

-- สรุปรายเดือนรวมใน SQL (ไม่ติดเพดาน 1,000 แถวของ API) เรียกจาก server เท่านั้น
create or replace function line_send_summary(p_from timestamptz)
returns table (mode text, kind text, ok boolean, fallback boolean, requests bigint, messages bigint)
language sql stable security definer set search_path = public as $$
  select mode, kind, ok, fallback, count(*), coalesce(sum(message_count), 0)
  from line_sends where created_at >= p_from
  group by mode, kind, ok, fallback
$$;
revoke all on function line_send_summary(timestamptz) from public, anon, authenticated;
grant execute on function line_send_summary(timestamptz) to service_role;
