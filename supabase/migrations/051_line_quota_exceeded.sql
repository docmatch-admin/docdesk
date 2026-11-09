-- push ที่ล้มเพราะโควตารายเดือนหมด (LINE 429 "monthly limit") ไม่ลองซ้ำ
alter table line_sends add column if not exists quota_exceeded boolean not null default false;
create index if not exists line_sends_quota_idx on line_sends (created_at) where quota_exceeded;
