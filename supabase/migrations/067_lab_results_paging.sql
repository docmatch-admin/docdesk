-- หน้าผลแล็บแบ่งหน้า 30 รายการ: ตัวกรองแท็บอยู่ใน SQL แล้วเรียงตามวันที่สั่งตรวจ
-- index ตามแท็บ (เรียง order_datetime desc ในตัว) · แท็บ "ส่งไม่สำเร็จ" / "ไม่ได้ผูก LINE" ใช้ notify_status
create index if not exists lab_results_unmatched_idx on lab_results (order_datetime desc) where match_status = 'unmatched';
create index if not exists lab_results_unviewed_idx on lab_results (order_datetime desc) where notify_status = 'sent' and first_viewed_at is null;
create index if not exists lab_results_notify_order_idx on lab_results (notify_status, order_datetime desc);
-- การ์ดสรุป "ผลใหม่วันนี้" (นับ created_at ของวันนี้)
create index if not exists lab_results_created_idx on lab_results (created_at desc);
