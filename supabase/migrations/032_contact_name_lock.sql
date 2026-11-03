-- เจ้าหน้าที่ตั้งชื่อลูกค้าเองได้ เช่น ลูกค้า Facebook ที่ยังอ่านชื่อจากโปรไฟล์ไม่ได้
-- ล็อกแล้ว webhook ของ LINE/Facebook/Instagram จะไม่เขียนชื่อทับ เขียนผ่าน API ด้วย service role เท่านั้น
alter table contacts add column if not exists name_locked boolean not null default false;
