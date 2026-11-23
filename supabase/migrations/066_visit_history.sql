-- ประวัติการมาตรวจในกล่องข้อมูลลูกค้า: เก็บสิทธิ วินิจฉัย อายุ จาก ovst_list เพิ่ม
-- (เจ้าหน้าที่เห็นเท่านั้น ไม่ส่งให้ AI) และค้นตาม HN ได้เร็ว
alter table his_visit_cache add column if not exists rights text;
alter table his_visit_cache add column if not exists diagnosis text;
alter table his_visit_cache add column if not exists age_y integer;
create index if not exists his_visit_cache_hn_idx on his_visit_cache (hn, visit_date desc);
