/**
 * Data Access Layer ของ "บัญชีตัวเอง" — เปลี่ยนอีเมล / เปลี่ยนรหัสผ่าน
 *
 * กติกาความปลอดภัยที่บังคับในชั้นนี้ (ไม่ใช่ใน route) เพื่อให้เทสครอบได้และเลี่ยงลืมในอนาคต:
 * - ทุกการเปลี่ยนแปลงต้องยืนยันรหัสผ่านปัจจุบัน — กันคนที่ยืมเครื่อง/ขโมย cookie ไปยึดบัญชี
 *   ด้วยการเปลี่ยนอีเมลแล้วรีเซ็ตรหัสผ่านทีหลัง
 * - เปลี่ยนรหัสผ่านแล้วเพิกถอน session ทั้งหมด — รหัสผ่านหลุดแล้วเปลี่ยนใหม่ต้องเตะคนอื่นออกจริง
 *   ไม่งั้น session เก่าที่คนร้ายถืออยู่ยังใช้ได้ต่อ (คนละเรื่องกับการรู้รหัสผ่าน)
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";
import { isValidEmail, normalizeEmail } from "./email";
import { destroyAllUserSessions } from "./session";

export const MIN_PASSWORD_LENGTH = 8;

/** ผลลัพธ์แบบ discriminated union — route แค่แปลง code เป็น HTTP status ไม่ต้องรู้ตรรกะ */
export type AccountResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): AccountResult {
  return { ok: false, status, error };
}

/** โหลดบัญชีของ userId — คืน null ถ้าถูกลบไปแล้วระหว่างที่ session ยังไม่หมดอายุ */
export async function getAccount(userId: number): Promise<User | null> {
  return (await db.query.users.findFirst({ where: eq(users.id, userId) })) ?? null;
}

/** ข้อมูลบัญชีที่ส่งกลับ client ได้ — จงใจไม่มี passwordHash */
export type AccountDTO = { username: string; email: string | null };

export function toAccountDTO(user: User): AccountDTO {
  return { username: user.username, email: user.email };
}

export async function changeEmail(input: {
  userId: number;
  currentPassword: string;
  newEmail: string;
}): Promise<AccountResult> {
  const user = await getAccount(input.userId);
  if (!user) return fail(401, "ไม่พบบัญชีนี้");
  if (!verifyPassword(input.currentPassword, user.passwordHash)) {
    return fail(401, "รหัสผ่านปัจจุบันไม่ถูกต้อง");
  }
  if (!isValidEmail(input.newEmail)) {
    return fail(400, "รูปแบบอีเมลไม่ถูกต้อง");
  }

  const email = normalizeEmail(input.newEmail);
  if (email === user.email) return { ok: true }; // ไม่มีอะไรเปลี่ยน — ไม่ต้องเขียน DB

  const taken = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (taken) return fail(409, "อีเมลนี้ถูกใช้กับบัญชีอื่นแล้ว");

  await db.update(users).set({ email }).where(eq(users.id, input.userId));
  return { ok: true };
}

export async function changePassword(input: {
  userId: number;
  currentPassword: string;
  newPassword: string;
}): Promise<AccountResult> {
  const user = await getAccount(input.userId);
  if (!user) return fail(401, "ไม่พบบัญชีนี้");
  if (!verifyPassword(input.currentPassword, user.passwordHash)) {
    return fail(401, "รหัสผ่านปัจจุบันไม่ถูกต้อง");
  }
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    return fail(400, `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`);
  }
  if (input.newPassword === input.currentPassword) {
    return fail(400, "รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม");
  }

  await db
    .update(users)
    .set({ passwordHash: hashPassword(input.newPassword) })
    .where(eq(users.id, input.userId));

  // เตะทุกอุปกรณ์ออก รวมถึงเครื่องที่กดเปลี่ยนเอง — route จะออก session ใหม่ให้เครื่องนี้ทันที
  await destroyAllUserSessions(input.userId);
  return { ok: true };
}
