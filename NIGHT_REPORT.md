# DocDesk: สรุปงานคืนนี้ (1 พ.ย. 2569)

## สถานะ
- โค้ดผ่าน test, typecheck และ build แล้ว และ commit ลง git แล้ว
- **ยังใช้งานจริงไม่ได้:** production ตอบ 404 เกือบทุกหน้าและทุก API
- **ขั้นที่ 4 ยังไม่ปรากฏใน project:** sign-up ยังเปิดอยู่และยังไม่มี user

## สิ่งที่ควรรู้ก่อน
1. **มีการ deploy ไปแล้ว 2 ครั้ง ก่อนได้รับคำสั่ง "ห้าม deploy"** ทำตามคำสั่งก่อนหน้าที่ให้ไปขั้นที่ 7 หลังได้รับคำสั่งใหม่ ผมไม่ได้ deploy เพิ่ม และไม่ได้ลบหรือย้อน deployment เหล่านั้น
2. **production ใช้งานไม่ได้:** https://docdesk-tau.vercel.app ตอบ 404 (`X-Vercel-Error: NOT_FOUND`) ที่ `/`, `/login`, `/inbox`, `/api/webchat`, `/api/cron/fallback` มีเพียง `/widget.js` ที่ได้ 200
   - สาเหตุที่น่าจะเป็น: Vercel ไม่ได้ build เป็น Next.js เพราะผมสร้าง project ด้วย `vercel project add` จึงอาจไม่ได้ตั้ง Framework Preset ยังไม่ได้ยืนยัน เพราะต้องใช้การล็อกอิน Vercel
   - **อย่าเพิ่งตั้ง LINE webhook และอย่าเพิ่งใส่ `<script>` บนเว็บ** จนกว่าจะแก้เสร็จ
3. **ขั้นที่ 4 ยังไม่ปรากฏ:** ตรวจล่าสุดใน `ncsgcplnuoiebadqdywx` ได้ `disable_signup = false` และ `auth.users` 0 แถว ระหว่างนี้ใครก็สมัครบัญชีได้ แต่ไม่มีสิทธิ์เข้าถึงข้อมูลแชท
4. **อีเมล ชื่อที่แสดง และรหัสผ่านที่ส่งมาว่างทุกครั้ง** จึงยังไม่ได้เพิ่มแถวใน `staff` (ตอนนี้ 0 แถว)

## ทำอะไรไปบ้าง
| ขั้น | สถานะ | รายละเอียด |
|---|---|---|
| 1 ฐานข้อมูล | เสร็จ | `001` และ `002` ขึ้นครบ, `vector` 0.8.2, มี `match_knowledge` และ `match_examples` |
| 2 `.env.local` | เสร็จ | คีย์ครบ ใช้ `CRON_SECRET` ตามที่ส่งมา |
| 3 embed | เสร็จ | `knowledge_items` มี embedding ครบ 23/23 แถว |
| 4 sign-up และ staff | **รอคุณ** | ดูด้านบน |
| 5 webchat และ `/send` | ผ่านบนเครื่อง | ทดสอบด้วย user ชั่วคราว ยังไม่ได้ทดสอบกับ user จริง |
| 6 โหมด auto | ผ่านบนเครื่อง | ตั้ง `ai_mode` กลับเป็น `assist` แล้ว |
| 7 Vercel | **ยังไม่สำเร็จ** | สร้าง project `docdesk` ใน team `doc-match` ตั้ง env แล้ว แต่ตอบ 404 |
| 8 cron | **ยังไม่ได้ทำ** | ยังไม่ได้รัน `003_fallback_cron.sql` และยังไม่ได้ 200 จาก `/api/cron/fallback` บน production |

## โค้ดที่แก้
- **`requireStaff()` ใน `src/lib/auth.ts`:** เช็กตาราง `staff` ด้วย session ของผู้ใช้ ไม่มีแถวคืน 403 มีผลกับ send, suggest, star และ knowledge
- **`src/lib/number-guard.ts` (ไฟล์ใหม่):** ตัวกันตัวเลข ถ้าคำตอบมีเลขที่ยืนยันไม่ได้ ความมั่นใจจะถูกจำกัดที่ 0.5 จึงไม่ถูกส่งอัตโนมัติ
  - ราคาและเวลาต้องมาจากฐานข้อมูล คำตอบใน `reply_examples` หรือข้อความ `sender_type = staff` เท่านั้น
  - ข้อความลูกค้ายืนยันได้เฉพาะจำนวนที่มีหน่วยนับ เช่น `2 เข็ม` และ `3 คน`
  - ไม่นับข้อความ AI และคำถามใน `reply_examples` เพราะเป็นคำพูดลูกค้า
  - เทียบรูปแบบเดียวกันแล้ว เช่น `08.00 = 8:00 = 8 โมง` และ `1,800 = 1800`
- **`src/lib/suggest.ts`:** ส่งหมวด `ข้อมูลคลินิก` ให้ AI ทุกครั้ง เพราะตอนทดสอบ AI แต่งเวลาวันเสาร์เป็น 9.00–17.00 น. (จริงคือ 08.00–12.00 น.) พร้อมความมั่นใจ 100%
- **ไฟล์อื่น:** ย้าย `003_fallback_cron.sql` ไป `supabase/manual/` เพื่อไม่ให้ `db push` รันค่าตัวอย่าง และเพิ่ม `.vercelignore` กับ `npm test`

## ผลทดสอบ
| รายการ | ผล |
|---|---|
| `npm test` | ผ่าน 18/18 รวมเคส "200 บาทใช่ไหม" และ "AI เคยตอบเลขผิดแล้วตอบซ้ำ" |
| `npm run typecheck` | ผ่าน |
| `npm run build` | ผ่าน |
| `/send`, สิทธิ์ staff และโหมด auto บนเครื่อง | ผ่าน 16/16 |
| ทดสอบบน production | ผ่าน 1/7 (ผ่านเฉพาะ `/widget.js`) |

รายละเอียดที่ผ่านบนเครื่อง:
- ไม่ได้ล็อกอินได้ 401
- user ที่ไม่มีแถวใน `staff` ได้ 403 ทั้ง 4 route และไม่มีข้อมูลถูกเขียน
- user ที่เป็น staff ส่งได้ และมีแถวใหม่ใน `reply_examples`
- โหมด auto ตอบราคาวัคซีนไข้หวัดใหญ่ 390 บาท
- คำถามเรื่องไข้และยา AI ไม่ตอบเอง และ `needs_human = true` (ทดสอบก่อนปรับตัวกันตัวเลขรอบล่าสุด ส่วนกฎ `needs_human` ไม่ได้เปลี่ยน)

ข้อจำกัดของการทดสอบ:
- เคส AI แต่งตัวเลขยืนยันด้วย unit test เท่านั้น ยังไม่เคยเกิดระหว่างรันจริงหลังเพิ่มตัวกัน
- การส่งข้อความผ่าน LINE ยังไม่เคยทดสอบ มีเพียงการตั้งคีย์ไว้

## ข้อมูลทดสอบ
ผมสร้าง user ชั่วคราว 2 คนด้วย service role (staff และ non-staff) แทนการใช้รหัสผ่านของคุณ และลบออกแล้ว สถานะล่าสุด:

| ตาราง | จำนวนแถว |
|---|---|
| `contacts`, `messages`, `suggestions`, `reply_examples` | 0 |
| `staff`, `auth.users` | 0 |
| `knowledge_items` | 23 (ข้อมูลตั้งต้น) |

## สิ่งที่รอคุณทำตอนเช้า
### ขั้นที่ 4: ปิด sign-up และสร้าง user
1. เปิด https://supabase.com/dashboard/project/ncsgcplnuoiebadqdywx/auth/providers ปิด **Allow new users to sign up** แล้วกด Save
2. ไปที่ Users → Add user แล้วติ๊ก Auto Confirm User
3. ส่งอีเมล ชื่อที่แสดง และรหัสผ่านชั่วคราวให้ผม ผมจะเพิ่มแถวใน `staff` เป็น admin
4. เช็กด้วยว่าไม่ได้ปิด sign-up หรือสร้าง user ไว้ใน `doc-match` หรือ `docmatch's Project` โดยไม่ตั้งใจ

### ทดสอบ `/send` ด้วย user จริง
ตรรกะผ่านแล้วด้วย user ชั่วคราว เหลือล็อกอินจริงที่ `/inbox` แล้วส่งข้อความ หลังขั้นที่ 7 ใช้งานได้

### ขั้นที่ 7: แก้ production
1. ที่ https://vercel.com/doc-match/docdesk/settings ตั้ง Framework Preset เป็น **Next.js** หรือให้ผมเพิ่ม `vercel.json` ที่ระบุ framework
2. อนุญาตให้ผม deploy ใหม่ แล้วทดสอบ `/login`, `/api/webchat` และ `/api/cron/fallback` ซ้ำ
3. เมื่อผ่านแล้วค่อยตั้งค่าสองอย่างนี้:
   - LINE Webhook URL: `https://docdesk-tau.vercel.app/api/webhooks/line`
   - โค้ดสำหรับเว็บ: `<script src="https://docdesk-tau.vercel.app/widget.js" defer></script>`

### ขั้นที่ 8: cron
ทำหลังขั้นที่ 7 ผมจะแทนค่า URL และ secret ตอนรันเท่านั้น ไฟล์ใน git จะยังเป็นค่าตัวอย่าง เพื่อไม่ให้ secret เข้า repo

## เรื่องที่ต้องตัดสินใจหรือจัดการ
- **ออกคีย์ใหม่:** คีย์ OpenAI, LINE Channel Secret, LINE Access Token และ `CRON_SECRET` อยู่ในประวัติแชท ควรออกใหม่ แล้วอัปเดตทั้ง `.env.local` และ Vercel
- **Region:** project อยู่ `ap-southeast-2` (ซิดนีย์) ถ้าต้องการสิงคโปร์ควรสร้างใหม่ก่อนมีข้อมูลจริง
- **ชื่อ project:** ใน Supabase ชื่อ `DocDesk's Project` ไม่ใช่ `docdesk`
- **แผน Vercel:** team `doc-match` ใช้แผน Hobby ซึ่งออกแบบมาสำหรับการใช้งานที่ไม่ใช่เชิงพาณิชย์ ควรตรวจเงื่อนไขก่อนใช้กับคลินิกจริง
- **Rate limit:** `/api/webchat` เปิดสาธารณะและเรียก OpenAI ทุกข้อความ README แนะนำให้เพิ่ม rate limit ก่อนใช้งานจริงจัง

## ข้อห้ามที่ปฏิบัติตาม
- หลังได้รับคำสั่งใหม่ ไม่ได้ deploy เพิ่ม
- ไม่ได้เปลี่ยน LINE webhook
- ไม่ได้รันคำสั่งใดกับ project อื่นใน Supabase นอกจากการเรียกดูรายชื่อ project แบบอ่านอย่างเดียว ซึ่งเห็นทั้งบัญชี mscclinic และ DocMatch
