-- สถานะ "อ่านแล้ว" ทั้งสองทาง
alter table messages
  add column if not exists line_mark_as_read_token text,      -- LINE: token ของข้อความเข้า
  add column if not exists read_by_customer_at timestamptz;   -- ข้อความขาออกที่ลูกค้าอ่านแล้ว

alter table conversations
  add column if not exists customer_marked_read_at timestamptz; -- เวลาที่เราแจ้งแพลตฟอร์มว่าอ่านแล้ว
