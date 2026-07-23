# คู่มือ Deploy — Vercel + Turso

เอกสารนี้ครอบขั้นตอน deploy News Curator ขึ้น production ทั้งหมด
ขั้นที่ต้องใช้บัญชี Turso/Vercel ของคุณเอง (สร้าง DB, ผูกโปรเจกต์, ใส่ env) ทำผ่าน CLI/หน้าเว็บของแต่ละบริการ

> เวอร์ชันนี้ยัง**ไม่มี scheduler อัตโนมัติ** (เฟส 5) — หลัง deploy ต้องกดปุ่ม "ดึงข่าวทันที" เอง
> การตั้ง Vercel Cron จะเพิ่มในเฟสถัดไป

---

## 0. ก่อนเริ่ม — ตรวจว่า build ผ่าน

```bash
npm run build
```

ถ้าผ่าน (ขึ้นตาราง route ทั้งหมด) แปลว่าไม่มี type error ที่จะทำให้ Vercel build ล้ม

---

> 💡 **ทำผ่านหน้าเว็บล้วนได้ (ไม่แตะ CLI เลย)** — สำหรับ DB ใหม่ ทุกขั้นทำผ่าน dashboard ได้หมด:
> Turso dashboard (สร้าง DB + วาง SQL) → Vercel dashboard (import repo + ใส่ env) → สมัครบัญชีแรกบนเว็บ (เป็น admin อัตโนมัติ)
> ดูทางเลือก "ผ่านหน้าเว็บ" ในแต่ละขั้นด้านล่าง (Option B)

## 1. สร้างฐานข้อมูล Turso

**Option A — CLI:** ติดตั้ง Turso CLI แล้วล็อกอิน (ทำครั้งเดียว):

```bash
# ดูวิธีติดตั้งล่าสุดที่ https://docs.turso.tech/cli/installation
turso auth login
turso db create news-curator
turso db show news-curator --url          # ได้ค่า DATABASE_URL (libsql://...)
turso db tokens create news-curator       # ได้ค่า DATABASE_AUTH_TOKEN
```

**Option B — หน้าเว็บ:** เปิด https://app.turso.tech → **Create Database**
→ เข้าไปที่ DB ที่สร้าง แท็บ/ปุ่ม **Connect** (หรือ "Connection details") จะมี:
- **URL** (`libsql://...`) = `DATABASE_URL`
- ปุ่ม **Create Token** / **Generate token** = `DATABASE_AUTH_TOKEN`

เก็บทั้งสองค่าไว้ใช้ในขั้นถัดไป

---

## 2. ตั้งโครงสร้างตาราง (schema) บน Turso

**Option A — CLI (drizzle-kit push):** ชี้ env ไปที่ Turso แล้ว push:

```bash
DATABASE_URL="libsql://<db>.turso.io" \
DATABASE_AUTH_TOKEN="<token>" \
npm run db:push
```

**Option B — วาง SQL ในหน้าเว็บ Turso (ไม่ต้องใช้ CLI):**
1. เปิด https://app.turso.tech → เลือกฐานข้อมูล → เมนู **SQL** / **Shell** (SQL console)
2. เปิดไฟล์ [`docs/schema.sql`](./schema.sql) ในโปรเจกต์ → คัดลอกทั้งไฟล์ → วางในช่อง SQL → **Run**
3. ไฟล์นั้นสร้างตารางครบทั้ง 8 ตาราง มี `IF NOT EXISTS` (วางซ้ำได้ไม่พัง) และจัดลำดับตารางแม่มาก่อนแล้ว

> ไฟล์ `docs/schema.sql` generate จาก schema จริงด้วย `npx drizzle-kit export` — ถ้าแก้ `src/db/schema.ts`
> ต้อง generate ใหม่: `npx drizzle-kit export --dialect=sqlite --schema=./src/db/schema.ts`
> แล้วจัดลำดับให้ตารางแม่ (users, topics) มาก่อนตารางที่อ้างถึง

> ⚠️ **ระวัง — landmine ตอนตั้ง schema ทับ DB ที่มีผู้ใช้อยู่แล้ว**
> คอลัมน์ `users.status` มี default = `pending` และ `role` default = `user`
> ถ้า DB มีผู้ใช้เดิมอยู่ พวกเขา**ทั้งหมดจะกลายเป็น "รออนุมัติ + ไม่ใช่ admin" ทันที** = ล็อกทุกคนออก
> แก้ด้วยขั้นตอนที่ 5 (bootstrap admin) ทันทีหลังตั้ง schema
> สำหรับ DB ใหม่ที่ยังว่าง ไม่มีปัญหานี้ — บัญชีแรกที่สมัครจะเป็น admin เอง

### 2b. อัปเดต schema ของ DB ที่ **ใช้งานอยู่แล้ว**

`docs/schema.sql` ใช้ `CREATE TABLE IF NOT EXISTS` — วางทับ DB เดิม **จะไม่เพิ่มคอลัมน์ใหม่ให้**
ตารางที่มีอยู่แล้วจะถูกข้ามไปเงียบ ๆ แล้วโค้ดใหม่จะพังตอน query ด้วย
`SQL_INPUT_ERROR: no such column: ...` (เคยเกิดจริงมาแล้วกับ `caption_include_summary`
ทำให้ `/api/topics` คืน 500 บน production ทั้งที่ local ปกติ)

คอลัมน์ที่เพิ่มหลังจากนั้น ต้องสั่ง `ALTER TABLE` เอง:

```sql
ALTER TABLE articles ADD COLUMN long_form_failed_at integer;
```

คอลัมน์ที่**เลิกใช้แล้ว** ไม่ต้องรีบลบ โค้ดไม่ได้อ่านมันแล้วและ SQLite ไม่แคร์คอลัมน์ส่วนเกิน
(`topics.caption_include_summary` — สวิตช์แคปชันยาวต่อหัวข้อที่ถอดออกไป) จะเก็บไว้เฉย ๆ ก็ได้
อยากลบให้สะอาดค่อยรันทีหลังตอนไม่มีคนใช้:

```sql
ALTER TABLE topics DROP COLUMN caption_include_summary;
```

> ⚠️ SQL console บนหน้าเว็บ Turso **รันได้ทีละ statement** — ถ้าวางหลายบรรทัดพร้อมกัน
> มันจะรันแค่บรรทัดแรกโดยไม่แจ้งเตือน ต้องวางทีละอันแล้วกด Run ทีละครั้ง
>
> ตรวจว่าขึ้นจริงแล้วด้วย: `SELECT long_form_failed_at FROM articles LIMIT 1;`
> (ถ้าคอลัมน์ยังไม่มี จะได้ error ทันที — ปลอดภัยกว่าเดาว่ารันผ่านแล้ว)

`ALTER TABLE ... ADD COLUMN` ของ SQLite เพิ่มคอลัมน์เปล่าให้แถวเดิมทั้งหมดเป็น NULL
ไม่ต้องหยุดระบบ และไม่กระทบข้อมูลเดิม

(optional) seed หัวข้อ "นางเงือก" เริ่มต้น — CLI: `npm run db:seed` (พร้อม env)
หรือผ่านหน้าเว็บ: ข้ามไปเลย แล้วสร้างหัวข้อเองในหน้า "จัดการหัวข้อ" หลังล็อกอิน

---

## 3. สร้าง AUTH_SECRET

production **ต้องตั้ง** `AUTH_SECRET` มิฉะนั้นระบบล็อกอินจะ throw (fail closed)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Deploy ขึ้น Vercel + ตั้ง Environment Variables

ผูกโปรเจกต์กับ Vercel (ผ่าน `vercel` CLI หรือ import repo จากหน้า vercel.com)
แล้วตั้ง Environment Variables เหล่านี้ (Production scope):

| ตัวแปร | จำเป็น | ค่า |
|---|---|---|
| `DATABASE_URL` | ✅ | `libsql://<db>.turso.io` จากขั้นที่ 1 |
| `DATABASE_AUTH_TOKEN` | ✅ | token จากขั้นที่ 1 |
| `AUTH_SECRET` | ✅ | ค่าสุ่มจากขั้นที่ 3 |
| `GEMINI_API_KEY` | ✅ (ถ้าใช้ AI) | key จาก https://aistudio.google.com |
| `GEMINI_MODEL` | – | default `gemini-flash-latest` |
| `GEMINI_BATCH_SIZE` | – | default `10` |
| `AUDIT_LOG_MAX_ENTRIES` | – | default `2000` |
| `ALLOW_REGISTRATION` | – | ตั้ง `false` เพื่อปิดรับสมัคร (บัญชีแรกยังสมัครได้เสมอ) |
| `FB_GRAPH_VERSION` | – | default `v23.0` |

> Facebook Page ID / Access Token **ไม่ได้อยู่ใน env** — ตั้งต่อหัวข้อในหน้า "จัดการหัวข้อ" ของแต่ละบัญชี

deploy:

```bash
vercel --prod
```

---

## 5. ตั้งบัญชี admin คนแรก

**กรณี DB ใหม่ (ว่าง):** เปิดเว็บที่ deploy แล้วไปหน้า `/register` — บัญชีแรกที่สมัครจะเป็น super admin ที่ใช้งานได้ทันทีโดยอัตโนมัติ **จบ ไม่ต้องทำอะไรเพิ่ม**

**กรณี push ทับ DB ที่มีผู้ใช้เดิม (จากคำเตือนในขั้นที่ 2):** รัน bootstrap เพื่อกู้บัญชีแรกกลับมาเป็น admin:

```bash
DATABASE_URL="..." DATABASE_AUTH_TOKEN="..." npm run db:bootstrap-admin
# หรือระบุชื่อบัญชีที่ต้องการให้เป็น admin:
DATABASE_URL="..." DATABASE_AUTH_TOKEN="..." npm run db:bootstrap-admin -- <username>
```

---

## 6. ตรวจหลัง deploy (smoke test)

1. เปิดเว็บ → ถูก redirect ไป `/login` (proxy กันทุกหน้า)
2. ล็อกอินบัญชี admin → เห็นเมนู "จัดการผู้ใช้"
3. หน้า "จัดการหัวข้อ" → ตั้ง Facebook Page ID + Token ของหัวข้อ → กดปุ่ม "ทดสอบการเชื่อมต่อ"
4. กดปุ่ม "ดึงข่าวทันที" → เห็นข่าวเข้ามา (ถ้าตั้ง GEMINI_API_KEY จะมีแคปชันร่างให้)

---

## กู้คืนกรณีฉุกเฉิน (admin ถูกล็อกออกทั้งหมด)

1. สมัครบัญชีใหม่ที่ `/register` (จะได้สถานะ "รออนุมัติ")
2. รัน `npm run db:bootstrap-admin -- <username ที่เพิ่งสมัคร>` พร้อม env ของ production
3. ล็อกอินด้วยบัญชีนั้น — เป็น admin ที่ใช้งานได้แล้ว

> เป็นทางเดียวที่กู้ได้โดยไม่ต้องแก้ DB ตรง ๆ เพราะระบบบังคับให้เหลือ admin อย่างน้อยหนึ่งคนเสมอ
