-- ยาที่ได้ต่อครั้ง (summary_drug ของ iService) ในกล่อง "ประวัติที่คลินิก" · เก็บ 1 ปีเหมือน his_visit_cache
-- ข้อมูลคนไข้: เจ้าหน้าที่เห็นผ่าน /api/conversations/[id]/visits (service role + กันแชทลับ) เท่านั้น ไม่ส่งเข้า AI
-- visit_date ใช้ลบรายการเก่ากว่า 1 ปี · summary_drug ไม่มีวิธีใช้ (usage_text ว่างได้)
create table if not exists his_visit_drug_cache (
  vn text not null,
  icode text not null,
  drug_name text not null,
  qty numeric,
  unit text,
  usage_text text,
  visit_date date not null,
  fetched_at timestamptz not null default now(),
  primary key (vn, icode)
);
create index if not exists his_visit_drug_cache_date_idx on his_visit_drug_cache (visit_date);

-- RLS แบบเดียวกับคอลัมน์ข้อมูลคนไข้ของ his_visit_cache (066): ห้ามอ่านตรงด้วย login เจ้าหน้าที่
alter table his_visit_drug_cache enable row level security;
revoke all on his_visit_drug_cache from anon, authenticated;
