/**
 * ตั้งบัญชีให้เป็น super admin ที่ใช้งานได้ — เครื่องมือ bootstrap/กู้คืนสิทธิ์ผู้ดูแลระบบ
 *
 * ใช้เมื่อไหร่:
 * 1. หลัง push schema ที่เพิ่ม role/status ขึ้น DB ที่มีผู้ใช้เดิม — ทุกแถวจะกลายเป็น pending/user
 *    (ค่า default ของคอลัมน์ใหม่) ทำให้ไม่มีใครล็อกอินได้ รันสคริปต์นี้เพื่อกู้บัญชีแรกกลับมา
 * 2. กรณีฉุกเฉิน admin ทั้งหมดถูกล็อกออก/ลืมรหัส — สมัครบัญชีใหม่ (จะได้สถานะ pending)
 *    แล้วรันสคริปต์นี้พร้อมชื่อผู้ใช้นั้น เพื่อเลื่อนขั้นเป็น admin ที่ใช้งานได้ทันที
 *
 * วิธีใช้:
 *   npm run db:bootstrap-admin -- <username>   # เลื่อนขั้นบัญชีที่ระบุ
 *   npm run db:bootstrap-admin                 # ไม่ระบุ = บัญชีที่สมัครก่อนสุด (id น้อยสุด)
 *
 * ปลอดภัยต่อการรันซ้ำ (idempotent) — ไม่สร้างบัญชีใหม่ ไม่แตะรหัสผ่าน
 */
import { asc, eq } from "drizzle-orm";
import { db } from "./index";
import { users } from "./schema";

async function bootstrapAdmin() {
  const username = process.argv[2]?.trim().toLowerCase();

  const target = username
    ? await db.query.users.findFirst({ where: eq(users.username, username) })
    : (await db.select().from(users).orderBy(asc(users.id)).limit(1))[0];

  if (!target) {
    if (username) {
      console.error(`❌ ไม่พบบัญชีชื่อ "${username}" — สมัครบัญชีนั้นก่อนแล้วรันใหม่`);
    } else {
      console.error(
        "❌ ยังไม่มีบัญชีในระบบเลย — สมัครบัญชีแรกผ่านหน้า /register (บัญชีแรกจะเป็น admin อัตโนมัติ)",
      );
    }
    process.exit(1);
  }

  if (
    target.role === "admin" &&
    target.status === "active" &&
    target.accessExpiresAt === null
  ) {
    console.log(`✓ บัญชี "${target.username}" เป็น super admin ที่ใช้งานได้อยู่แล้ว — ไม่ต้องทำอะไร`);
    process.exit(0);
  }

  await db
    .update(users)
    .set({ role: "admin", status: "active", accessExpiresAt: null })
    .where(eq(users.id, target.id));

  console.log(
    `✅ ตั้ง "${target.username}" (id=${target.id}) เป็น super admin ที่ใช้งานได้แล้ว ` +
      `(role=admin, status=active, ไม่มีวันหมดอายุ)`,
  );
}

bootstrapAdmin().then(() => process.exit(0));
