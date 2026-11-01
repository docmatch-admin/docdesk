-- รับ-ส่งรูปภาพ: bucket เป็น private ทั้งคู่ เปิดดูผ่าน signed URL เท่านั้น
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('chat-media', 'chat-media', false, 10485760),
  ('quick-media', 'quick-media', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- เจ้าหน้าที่ขอ signed URL จากเบราว์เซอร์ได้ ส่วนการเขียนทำผ่าน server ด้วย service role เท่านั้น
drop policy if exists staff_read_media on storage.objects;
create policy staff_read_media on storage.objects for select to authenticated
  using (bucket_id in ('chat-media', 'quick-media') and is_staff());

alter table messages
  add column if not exists media_type text,
  add column if not exists media_path text,
  add column if not exists media_preview_path text,
  add column if not exists media_width int,
  add column if not exists media_height int,
  add column if not exists media_deleted_at timestamptz;

-- cron ค้นรูปที่หมดอายุทุกนาที
create index if not exists messages_media_expiry_idx on messages (created_at) where media_path is not null;

create table if not exists quick_media (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  path text not null,
  preview_path text not null,
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table quick_media enable row level security;
drop policy if exists staff_all on quick_media;
create policy staff_all on quick_media for all to authenticated using (is_staff()) with check (is_staff());

insert into settings (key, value) values ('media_retention_days', '90') on conflict (key) do nothing;
