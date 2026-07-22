/**
 * Data Access Layer ของ session — จุดเดียวที่ route/layout เรียกเพื่อรู้ว่า "ใครล็อกอินอยู่"
 * ทำ secure check: ยืนยัน HMAC (optimistic) แล้วเช็คว่าแถว session ยังมีใน DB และไม่หมดอายุ
 * ลบแถวใน DB = เพิกถอน session อันนั้นทันที (แก้ข้อจำกัด stateless เดิม)
 */
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { checkUserAccess } from "./user-access";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signSessionToken,
  verifyTokenOptimistic,
} from "./auth";

export { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS };

/** สร้าง session ใหม่ในฐานข้อมูล แล้วคืน token สำหรับใส่ cookie */
export async function createSession(userId: number): Promise<string> {
  const sessionId = randomBytes(32).toString("hex");
  const expSec = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt: new Date(expSec * 1000),
  });
  return signSessionToken(sessionId, userId, expSec);
}

/**
 * secure check จาก token: คืน userId ถ้า token ถูกต้อง + session ยังไม่ถูกเพิกถอน/หมดอายุ
 * + บัญชียังใช้งานได้ (ไม่ pending/revoked/หมดอายุสิทธิ์)
 *
 * เช็คสถานะบัญชีตรงนี้ด้วย ไม่ใช่แค่ตอนล็อกอิน เพราะ admin เพิกถอนสิทธิ์ระหว่างที่คนนั้น
 * ล็อกอินค้างอยู่ได้ — ถ้าเช็คแค่ตอนล็อกอิน session เดิมจะใช้ต่อได้อีก 30 วัน
 * (จุดนี้คือคอขวดที่ทุก route/layout เรียก จึงกันได้ทั้งระบบโดยไม่ต้องไปแก้ทีละ route)
 */
export async function resolveUserId(token: string | undefined): Promise<number | null> {
  if (!token) return null;
  const opt = await verifyTokenOptimistic(token);
  if (!opt) return null;
  const row = await db.query.sessions.findFirst({
    where: and(eq(sessions.id, opt.sessionId), gt(sessions.expiresAt, new Date())),
  });
  if (!row || row.userId !== opt.userId) return null;

  const user = await db.query.users.findFirst({ where: eq(users.id, opt.userId) });
  if (!user || !checkUserAccess(user).usable) return null;
  return opt.userId;
}

/** ดึง userId จาก request (สำหรับ API route handlers) */
export async function getUserId(req: NextRequest): Promise<number | null> {
  return resolveUserId(req.cookies.get(SESSION_COOKIE)?.value);
}

/** ลบ session ของ token นี้ (logout) */
export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  const opt = await verifyTokenOptimistic(token);
  if (opt) await db.delete(sessions).where(eq(sessions.id, opt.sessionId));
}

/** เพิกถอนทุก session ของผู้ใช้ (เช่น เปลี่ยนรหัสผ่าน / เตะออกทุกอุปกรณ์) */
export async function destroyAllUserSessions(userId: number): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
