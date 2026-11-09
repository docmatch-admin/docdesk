-- ชุดนัดฉีดหลายเข็ม: series_seq = เลขเข็ม, เข็มที่ฉีดแล้ว (วันนี้และเข็มก่อนหน้าที่รู้วัน) เก็บเป็นรายการ "ฉีดแล้ว"
-- รายการฉีดแล้วไม่ใช่นัด: status = attended ไม่ส่งเตือน ไม่อยู่ในรายการนัด/จำนวนนัด แสดงเฉพาะในตารางของชุด
alter table appointments add column if not exists series_done boolean not null default false;
create index if not exists appointments_not_done_idx on appointments (appoint_date) where not series_done;
