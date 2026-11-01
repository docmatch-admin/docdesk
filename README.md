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
6. **LINE**: LINE Developers → Messaging API → Webhook URL = `https://<app>/api/webhooks/line` → เปิด Use webhook, ปิด Auto-reply/Greeting และ**เปิด Chat** ใน Response settings ของ LINE OA Manager (ถ้าปิด Chat ลูกค้าจะเห็น "อ่านแล้ว" ทันทีทุกข้อความ แม้ยังไม่มีใครเปิดอ่าน)
7. **เว็บไซต์**: ใส่ในทุกหน้าของ happiwellclinic.com
   ```html
   <script src="https://<app>/widget.js" defer></script>
   ```
   (หน้าที่ `<html lang="en">` จะแสดงปุ่มเป็นภาษาอังกฤษอัตโนมัติ)
8. **โหมดคนตอบก่อน**: แก้ URL/secret ใน `supabase/manual/003_fallback_cron.sql` แล้วรันใน Supabase (เรียก cron ทุกนาที) ไฟล์นี้แยกจาก `migrations/` เพื่อไม่ให้ `supabase db push` รันค่าตัวอย่าง และอย่า commit secret จริง

## หมายเหตุ
- LINE: ข้อความแรกที่ตอบภายใน 50 วินาทีหลังลูกค้าทักใช้ replyToken (ฟรี ทั้ง AI และเจ้าหน้าที่) นอกนั้นหรือถ้า reply ไม่สำเร็จใช้ push ซึ่งนับโควต้าข้อความของ LINE OA
- PDPA: แชทมีข้อมูลสุขภาพ เก็บใน Supabase ของคลินิกเอง ควรเพิ่มข้อความแจ้งการเก็บข้อมูลในข้อความทักทาย/นโยบายความเป็นส่วนตัวของเว็บ
- Web chat endpoint มีตัวป้องกัน (`src/lib/webchat-guard.ts`, migration `006`): 5 ครั้ง/นาที และ 30 ครั้ง/ชั่วโมงต่อ session (นับทั้งข้อความและรูป), 3 session ใหม่/ชั่วโมงต่อ IP, AI 300 ข้อความ/วัน (เกินแล้วเก็บข้อความให้คนตอบ), รูป 100 รูป/วันทั้งช่องทางเว็บ (migration `011`), รับเฉพาะ Origin ของเว็บคลินิกและ localhost · เพิ่มโดเมนใหม่ต้องแก้ `ALLOWED_ORIGINS`
- สถานะอ่านแล้ว (`src/lib/read-receipts.ts`, migration `007`): ลูกค้าเห็นว่าอ่านแล้วเมื่อเจ้าหน้าที่เปิดแชท หรือ AI ส่งคำตอบเองสำเร็จ ไม่ใช่ตอนแค่สร้างคำแนะนำ · หน้า inbox แสดง "✓✓ อ่านแล้ว" เฉพาะ Facebook, Instagram และเว็บ เพราะ LINE ไม่ส่งข้อมูลการอ่านของลูกค้ามาให้
- ลดการเรียก AI (`src/lib/suggest-rules.ts`, migration `008`): โหมดปิด/ผู้ช่วยร่างตอนเจ้าหน้าที่เปิดแชท ครั้งเดียวต่อชุดข้อความ · โหมดอัตโนมัติ/คนตอบก่อนรอ 8 วินาทีหลังข้อความล่าสุด · คำขอบคุณ/รับทราบ/อีโมจิ/ไฟล์แนบไม่ร่าง · คำตอบติดดาวที่คล้าย ≥ 0.92 ใช้ได้เลยเมื่อไม่ใช่เรื่องการแพทย์ ไม่ได้คุยต่อเนื่องใน 30 นาที และตัวเลขยืนยันได้ · ปุ่ม "แนะนำใหม่" เรียก LLM เสมอ · สถิติอยู่ในหน้าตั้งค่า อัตราแลกเปลี่ยนและราคาอยู่ใน `src/lib/llm-usage.ts`
- รูปภาพ (`src/lib/media.ts`, `src/lib/media-store.ts`, migration `009`): bucket `chat-media` และ `quick-media` เป็น private · ไฟล์อัปโหลดตรงเข้า Storage ก่อน เพราะ Vercel รับ request ได้ไม่เกิน 4.5MB แล้ว server ตรวจ magic bytes และบีบอัด · ต้องตั้ง `MEDIA_URL_SECRET` (เปลี่ยนแล้วลิงก์รูปที่ส่งไป LINE/Meta ก่อนหน้าจะใช้ไม่ได้) · รูปที่ส่งแต่รูปไม่เข้า AI และติดป้าย "ต้องให้คนตอบ" · รูปในแชทถูกลบตาม "การเก็บรูปภาพ" ในหน้าตั้งค่า (เริ่มต้น 90 วัน) และลายเซ็น URL ขาออกมีอายุเท่ากัน
- แท็ก (`src/lib/tags.ts`, migration `010`): ติดเอง, กฎคำสำคัญและคำยกเว้นในหน้าตั้งค่า (คั่นด้วย `|` เป็นข้อความธรรมดา), กฎภาษาอื่น (ครบ 2 ข้อความตามภาษาที่ระบบแปลตรวจได้) และ AI เสนอในการเรียกเดียวกับการร่างคำตอบ โหมดอัตโนมัติติดเองเฉพาะกลุ่ม topic · เจ้าหน้าที่เอาแท็กออกแล้ว กฎและ AI จะไม่ติดกลับให้แชทนั้น · เปลี่ยนชื่อแท็กไม่ได้เพราะแชทเก็บเป็นชื่อ · รายงานอยู่ที่ `/reports` นับจาก `tag_events`

## เฟส 2: Facebook Messenger + Instagram
โค้ดพร้อมแล้ว (`/api/webhooks/meta`) เหลือตั้งค่าฝั่ง Meta:
1. รัน `supabase/migrations/004_meta_channels.sql`
2. developers.facebook.com → **Create App** (ประเภท Business) → เพิ่ม use case Messenger และ Instagram
3. เชื่อม Facebook Page ของคลินิก และ Instagram Professional account ที่ผูกกับเพจนั้น
   - ใน Instagram app: ตั้งค่า → ความเป็นส่วนตัว → ข้อความ → เปิด **อนุญาตการเข้าถึงข้อความ** (Connected tools)
4. ออก Page access token แบบไม่หมดอายุ: Business Settings → **System users** → สร้าง → Assign assets (Page) → Generate token สิทธิ์ `pages_messaging`, `pages_manage_metadata`, `instagram_basic`, `instagram_manage_messages`
5. Webhooks: Callback URL `https://<app>/api/webhooks/meta` · Verify token = `META_VERIFY_TOKEN` · subscribe field `messages` ทั้งของ Page และ Instagram · เพิ่ม `message_reads` ของ Page และ `messaging_seen` ของ Instagram เพื่อแสดง "✓✓ อ่านแล้ว" (Instagram ไม่ได้ใช้ชื่อ `message_reads`)
6. ใส่ env: `META_APP_SECRET` (App settings → Basic), `META_VERIFY_TOKEN` (ตั้งเอง), `META_PAGE_ACCESS_TOKEN`
7. **App Review + Business verification** เพื่อขอสิทธิ์ `pages_messaging` และ `instagram_manage_messages` (ก่อนอนุมัติ ทดสอบได้เฉพาะบัญชีที่มี role ในแอป) ขอ **Human Agent** เพิ่มถ้าต้องการตอบหลัง 24 ชม.

กติกาเวลา: ภายใน 24 ชม. หลังลูกค้าทักล่าสุด ส่งได้ปกติ · 24 ชม.–7 วัน เฉพาะเจ้าหน้าที่ (ต้องมีสิทธิ์ Human Agent) · เกิน 7 วันส่งไม่ได้ — หน้าแชทแสดงแถบเตือนให้อัตโนมัติ

## ส่งออกข้อมูลสำหรับเทรน
หน้า “ฐานข้อมูล & คำตอบ” → แท็บคำตอบที่เรียนรู้ → **ส่งออกข้อมูลสำหรับเทรน** ได้ไฟล์ JSONL รูปแบบ chat fine-tuning (เฉพาะคำตอบที่ติดดาวหรือถูกเลือกใช้ ≥ 2 ครั้ง ตัดข้อมูลส่วนตัวซ้ำอีกรอบ) · `?all=1` เอาทั้งหมด

## สำรองข้อมูล
`.github/workflows/backup.yml` รันทุกวันตี 3 เวลาไทย ทำ `pg_dump` เฉพาะ schema `public` เข้ารหัสด้วย [age](https://github.com/FiloSottile/age) แล้วเก็บ 30 ไฟล์ล่าสุดใน branch `backups` ไม่รวมไฟล์รูปใน Storage และบัญชีเจ้าหน้าที่ใน schema `auth`

### ตั้งค่าครั้งแรก
1. สร้าง repo แบบ **private** บน GitHub แล้ว push โค้ด
2. สร้างกุญแจบนเครื่องตัวเอง: `age-keygen -o docdesk-backup-key.txt` เก็บไฟล์นี้ไว้นอก repo เช่น ในตัวจัดการรหัสผ่าน **ถ้ากุญแจหายจะกู้ข้อมูลไม่ได้เลย**
3. GitHub → Settings → Secrets and variables → Actions เพิ่ม
   - `BACKUP_AGE_PUBLIC_KEY` = บรรทัด `public key: age1...` ในไฟล์กุญแจ (ใส่แค่กุญแจสาธารณะ GitHub จึงถอดรหัสไฟล์สำรองเองไม่ได้)
   - `SUPABASE_DB_URL` = Supabase → Connect → **Session pooler** (พอร์ต 5432) ต้องใช้ pooler เพราะเครื่องของ GitHub Actions ต่อ IPv6 ไม่ได้
4. กด Actions → Backup database → Run workflow แล้วดูว่า branch `backups` มีไฟล์

### กู้คืน
```bash
git fetch origin backups && git show origin/backups:docdesk-2026-11-02.sql.gz.age > backup.age
age -d -i docdesk-backup-key.txt backup.age | gunzip > backup.sql

# ทดลองกู้ลงเครื่องตัวเองก่อนเสมอ (ต้องมี Docker)
npx supabase start
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres
psql "$DB" -c 'drop schema public cascade; create schema public; grant all on schema public to postgres, anon, authenticated, service_role;'
psql "$DB" -c 'create extension if not exists vector with schema public;'
psql "$DB" -f backup.sql
psql "$DB" -c 'select count(*) from messages; select count(*) from conversations;'
```
- **error ที่คาดไว้:** `staff_id_fkey` เพราะไฟล์สำรองไม่มี `auth.users` ต้องสร้างบัญชีเจ้าหน้าที่ใหม่ใน Authentication แล้วแก้ `staff.id` ให้ตรง
- **กู้ขึ้น production:** สร้าง project ใหม่ กู้ลงที่นั่น ตรวจข้อมูล แล้วเปลี่ยน env ใน Vercel อย่ากู้ทับ project ที่ใช้งานอยู่
- **หลังกู้:** ต้องตั้ง cron ใหม่ด้วย `supabase/manual/` และ bucket รูปจะว่าง ข้อความยังอยู่แต่รูปเปิดไม่ได้

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
