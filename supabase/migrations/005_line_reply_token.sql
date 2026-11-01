-- LINE replyToken ล่าสุด (ตอบฟรี ไม่นับโควต้า ใช้ได้ครั้งเดียวภายใน ~1 นาที)
alter table conversations
  add column if not exists line_reply_token text,
  add column if not exists line_reply_token_at timestamptz;
