-- คนไข้เลิกติดตาม/บล็อก LINE OA: ข้อความนัดส่งไม่ถึง ให้ขึ้น "ส่งไม่ได้-ต้องโทร" และใบนัดพิมพ์ QR ให้สแกนใหม่
-- ตั้งจาก webhook event unfollow ล้างเมื่อ follow กลับ
alter table contacts add column if not exists line_unfollowed_at timestamptz;
