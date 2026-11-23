-- ประวัติการมาตรวจในกล่องข้อมูลลูกค้า: เก็บสิทธิ วินิจฉัย อายุ จาก ovst_list เพิ่ม
-- (เจ้าหน้าที่เห็นเท่านั้น ไม่ส่งให้ AI) และค้นตาม HN ได้เร็ว
alter table his_visit_cache add column if not exists rights text;
alter table his_visit_cache add column if not exists diagnosis text;
alter table his_visit_cache add column if not exists age_y integer;
create index if not exists his_visit_cache_hn_idx on his_visit_cache (hn, visit_date desc);

-- สิทธิ/วินิจฉัย/อายุ เป็นข้อมูลคนไข้: ห้ามอ่านตรงด้วย login เจ้าหน้าที่ (ข้ามการกันแชทลับของ API ได้)
-- อ่านผ่าน /api/conversations/[id]/visits (service role + denySensitiveChat) เท่านั้น
-- คอลัมน์เดิมยังอ่านได้เหมือนเดิม (โค้ดทุกจุดที่อ่านตารางนี้ใช้ service role อยู่แล้ว)
revoke select on his_visit_cache from authenticated;
grant select (vn, hn, patient_name, visit_date, visit_time, doctor_name, fetched_at) on his_visit_cache to authenticated;
