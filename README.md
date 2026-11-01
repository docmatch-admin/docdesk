# DocDesk — รวมแชททุกช่องทาง + AI ผู้ช่วยตอบ (เฟส 1)

ระบบ Unified Inbox สำหรับคลินิก (ใช้งานครั้งแรกที่แฮปปี้เวลล์ คลินิกเวชกรรม): เจ้าหน้าที่ตอบเป็นหลัก AI เป็นผู้ช่วย และเรียนรู้จากคำตอบจริงของคลินิก

## ฟีเจอร์ในเฟสนี้
| ฟีเจอร์ | รายละเอียด |
|---|---|
| ช่องทาง | LINE OA (@p49clinic) + ปุ่มแชทบนเว็บไซต์ (`widget.js`) |
| สวิตช์ AI 4 โหมด | ปิด / ผู้ช่วย / คนตอบก่อน / อัตโนมัติ — ตั้งได้ 3 ระดับ: ทั้งระบบ → รายช่องทาง → รายแชท |
| คนตอบก่อน | ไม่มีใครตอบใน X นาที หรือนอกเวลาทำการ → AI ตอบแทน |
| แปลภาษา | ลูกค้าพิมพ์ภาษาอะไร เจ้าหน้าที่เห็นเป็นไทย ตอบไทย ระบบแปลกลับ (มีตัวเลือกส่งตามที่พิมพ์) |
| แนะนำคำตอบ 3 แหล่ง | ① ฐานข้อมูลคลินิก ② คำตอบเดิมของเจ้าหน้าที่ ③ ประวัติลูกค้าคนนั้น — โชว์ % ความมั่นใจและแหล่งที่มา |
| เรียนรู้อัตโนมัติ | ทุกคำตอบของเจ้าหน้าที่ถูกเก็บเป็นตัวอย่าง (ตัดเบอร์/เลขบัตร/อีเมล/HN ก่อนเก็บ) · คำแนะนำที่ถูกเลือกบ่อยขึ้นก่อน · กด ☆ ที่ข้อความ = คำตอบมาตรฐาน |
| กันข้อมูลเก่า | ถ้าคำตอบเดิมขัดกับฐานข้อมูล AI ใช้ข้อมูลใหม่และแจ้งในคำแนะนำ · ซ่อนคำตอบเก่าได้ในหน้า “คำตอบที่เรียนรู้” |
| ความปลอดภัยทางการแพทย์ | เรื่องอาการ/ยา/ผลแล็บ/ร้องเรียน → ติดป้าย “ต้องให้คนตอบ” AI ไม่ส่งเองแม้อยู่โหมดอัตโนมัติ |

## ติดตั้ง
1. **Supabase** สร้างโปรเจกต์ใหม่ แล้วรัน SQL ตามลำดับ
   - `supabase/migrations/001_init.sql`
   - `supabase/migrations/002_seed_knowledge.sql` (ข้อมูลคลินิกตั้งต้น)
2. คัดลอก `.env.example` → `.env.local` แล้วกรอกค่า
3. `npm install` → `npm run embed` (สร้าง embedding ให้ข้อมูลตั้งต้น) → `npm run dev`
4. **เจ้าหน้าที่**: Supabase → Authentication → Sign In / Providers → **ปิด “Allow new users to sign up”** แล้วไปที่ Users → Add user จากนั้นรัน SQL
   ```sql
   insert into staff (id, display_name, role)
   select id, 'ชื่อเจ้าหน้าที่', 'admin' from auth.users where email = 'อีเมล@example.com';
   ```
   (ผู้ใช้ที่ไม่มีแถวใน `staff` ล็อกอินได้แต่จะไม่เห็นข้อมูลใดๆ)
5. **Deploy** บน Vercel แล้วตั้ง env เหมือน `.env.local`
6. **LINE**: LINE Developers → Messaging API → Webhook URL = `https://<app>/api/webhooks/line` → เปิด Use webhook, ปิด Auto-reply/Greeting ของ LINE OA Manager
7. **เว็บไซต์**: ใส่ในทุกหน้าของ happiwellclinic.com
   ```html
   <script src="https://<app>/widget.js" defer></script>
   ```
   (หน้าที่ `<html lang="en">` จะแสดงปุ่มเป็นภาษาอังกฤษอัตโนมัติ)
8. **โหมดคนตอบก่อน**: แก้ URL/secret ใน `supabase/manual/003_fallback_cron.sql` แล้วรันใน Supabase (เรียก cron ทุกนาที) ไฟล์นี้แยกจาก `migrations/` เพื่อไม่ให้ `supabase db push` รันค่าตัวอย่าง และอย่า commit secret จริง

## หมายเหตุ
- LINE: ข้อความแรกที่ตอบภายใน 50 วินาทีหลังลูกค้าทักใช้ replyToken (ฟรี ทั้ง AI และเจ้าหน้าที่) นอกนั้นหรือถ้า reply ไม่สำเร็จใช้ push ซึ่งนับโควต้าข้อความของ LINE OA
- PDPA: แชทมีข้อมูลสุขภาพ เก็บใน Supabase ของคลินิกเอง ควรเพิ่มข้อความแจ้งการเก็บข้อมูลในข้อความทักทาย/นโยบายความเป็นส่วนตัวของเว็บ
- Web chat endpoint มีตัวป้องกัน (`src/lib/webchat-guard.ts`, migration `006`): 5 ข้อความ/นาที และ 30 ข้อความ/ชั่วโมงต่อ session, 3 session ใหม่/ชั่วโมงต่อ IP, AI 300 ข้อความ/วัน (เกินแล้วเก็บข้อความให้คนตอบ), รับเฉพาะ Origin ของเว็บคลินิกและ localhost · เพิ่มโดเมนใหม่ต้องแก้ `ALLOWED_ORIGINS`

## เฟส 2: Facebook Messenger + Instagram
โค้ดพร้อมแล้ว (`/api/webhooks/meta`) เหลือตั้งค่าฝั่ง Meta:
1. รัน `supabase/migrations/004_meta_channels.sql`
2. developers.facebook.com → **Create App** (ประเภท Business) → เพิ่ม use case Messenger และ Instagram
3. เชื่อม Facebook Page ของคลินิก และ Instagram Professional account ที่ผูกกับเพจนั้น
   - ใน Instagram app: ตั้งค่า → ความเป็นส่วนตัว → ข้อความ → เปิด **อนุญาตการเข้าถึงข้อความ** (Connected tools)
4. ออก Page access token แบบไม่หมดอายุ: Business Settings → **System users** → สร้าง → Assign assets (Page) → Generate token สิทธิ์ `pages_messaging`, `pages_manage_metadata`, `instagram_basic`, `instagram_manage_messages`
5. Webhooks: Callback URL `https://<app>/api/webhooks/meta` · Verify token = `META_VERIFY_TOKEN` · subscribe field `messages` ทั้งของ Page และ Instagram
6. ใส่ env: `META_APP_SECRET` (App settings → Basic), `META_VERIFY_TOKEN` (ตั้งเอง), `META_PAGE_ACCESS_TOKEN`
7. **App Review + Business verification** เพื่อขอสิทธิ์ `pages_messaging` และ `instagram_manage_messages` (ก่อนอนุมัติ ทดสอบได้เฉพาะบัญชีที่มี role ในแอป) ขอ **Human Agent** เพิ่มถ้าต้องการตอบหลัง 24 ชม.

กติกาเวลา: ภายใน 24 ชม. หลังลูกค้าทักล่าสุด ส่งได้ปกติ · 24 ชม.–7 วัน เฉพาะเจ้าหน้าที่ (ต้องมีสิทธิ์ Human Agent) · เกิน 7 วันส่งไม่ได้ — หน้าแชทแสดงแถบเตือนให้อัตโนมัติ

## ส่งออกข้อมูลสำหรับเทรน
หน้า “ฐานข้อมูล & คำตอบ” → แท็บคำตอบที่เรียนรู้ → **ส่งออกข้อมูลสำหรับเทรน** ได้ไฟล์ JSONL รูปแบบ chat fine-tuning (เฉพาะคำตอบที่ติดดาวหรือถูกเลือกใช้ ≥ 2 ครั้ง ตัดข้อมูลส่วนตัวซ้ำอีกรอบ) · `?all=1` เอาทั้งหมด

## เฟสถัดไป
3. Dashboard สถิติ · 4. WhatsApp + บรอดแคสต์ · รูปภาพ/สติกเกอร์

## โครงสร้าง
```
src/lib/pipeline.ts      ขาเข้า/ขาออก, โหมด AI, เรียนรู้, fallback
src/lib/suggest.ts       แนะนำคำตอบจาก 3 แหล่ง
src/lib/translate.ts     ตรวจภาษา + แปล
src/lib/channels/        LINE (และช่องทางอื่นในอนาคต)
src/app/(staff)/inbox    หน้าแชทเจ้าหน้าที่
src/app/api/...          webhook, web chat, send, suggest, star, knowledge, cron
public/widget.js         ปุ่มแชทสำหรับฝังเว็บ
```
