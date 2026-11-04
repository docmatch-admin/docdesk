-- ไฟล์เอกสารในแชท (PDF): ใช้ media_path และระบบลบตามอายุเดิม เพิ่มชื่อและขนาดไฟล์
alter table messages add column if not exists file_name text;
alter table messages add column if not exists file_size integer;

-- Messenger และ Instagram รับไฟล์ได้ถึง 25MB รูปยังถูกจำกัด 10MB ที่ server
update storage.buckets set file_size_limit = 26214400 where id = 'chat-media';
