/**
 * Rate limit แบบ DB-backed สำหรับ endpoint ที่ล่อ brute-force (login/register)
 * ใช้ DB แทน in-memory เพราะบน serverless แต่ละ instance มี memory แยกกัน in-memory จึงกันไม่ได้จริง
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { authAttempts } from "@/db/schema";

const WINDOW_MS = 15 * 60 * 1000; // 15 นาที
const MAX_ATTEMPTS = 10;

/** ระบุ client จาก IP (บน Vercel มาจาก x-forwarded-for) */
export function clientIdentifier(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  return ip;
}

/** เช็คว่า identifier นี้ยิงเกินโควตาในหน้าต่างเวลาหรือยัง */
export async function isRateLimited(identifier: string): Promise<boolean> {
  const row = await db.query.authAttempts.findFirst({
    where: eq(authAttempts.identifier, identifier),
  });
  if (!row) return false;
  if (Date.now() - row.windowStart.getTime() > WINDOW_MS) return false; // หน้าต่างหมดอายุ = เริ่มนับใหม่
  return row.count >= MAX_ATTEMPTS;
}

/** บันทึกความพยายามที่ล้มเหลว 1 ครั้ง (reset นับใหม่ถ้าเลยหน้าต่างเดิม) */
export async function recordFailedAttempt(identifier: string): Promise<void> {
  const now = new Date();
  const row = await db.query.authAttempts.findFirst({
    where: eq(authAttempts.identifier, identifier),
  });
  if (!row || Date.now() - row.windowStart.getTime() > WINDOW_MS) {
    await db
      .insert(authAttempts)
      .values({ identifier, count: 1, windowStart: now })
      .onConflictDoUpdate({
        target: authAttempts.identifier,
        set: { count: 1, windowStart: now },
      });
    return;
  }
  await db
    .update(authAttempts)
    .set({ count: row.count + 1 })
    .where(eq(authAttempts.identifier, identifier));
}

/** ล้างตัวนับหลังล็อกอินสำเร็จ */
export async function clearAttempts(identifier: string): Promise<void> {
  await db.delete(authAttempts).where(eq(authAttempts.identifier, identifier));
}
