import { count } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

/**
 * รับสมัครสมาชิกใหม่ได้หรือไม่
 * - ถ้ายังไม่มีบัญชีในระบบเลย → เปิดเสมอ (bootstrap บัญชีแรก กัน deploy ที่ปิดรับสมัครแล้วล็อกตัวเองออก)
 * - ถ้ามีบัญชีแล้ว → เปิดต่อเมื่อ ALLOW_REGISTRATION ไม่ใช่ "false" (ค่าเริ่มต้น = เปิด)
 */
export async function isRegistrationOpen(): Promise<boolean> {
  const [{ value }] = await db.select({ value: count() }).from(users);
  if (value === 0) return true;
  return process.env.ALLOW_REGISTRATION !== "false";
}
