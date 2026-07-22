import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/session";
import { verifyPassword } from "@/lib/password";
import { checkUserAccess } from "@/lib/user-access";
import {
  clearAttempts,
  clientIdentifier,
  isRateLimited,
  recordFailedAttempt,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/** POST /api/auth/login — ตรวจชื่อผู้ใช้+รหัสผ่านแล้วตั้ง session cookie อายุ 30 วัน */
export async function POST(req: NextRequest) {
  const identifier = clientIdentifier(req);
  if (await isRateLimited(identifier)) {
    return NextResponse.json(
      { error: "พยายามล็อกอินบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" },
      { status: 429 },
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const username = body.username?.trim().toLowerCase();
  if (!username || !body.password) {
    return NextResponse.json(
      { error: "ต้องระบุชื่อผู้ใช้และรหัสผ่าน" },
      { status: 400 },
    );
  }

  const user = await db.query.users.findFirst({
    where: eq(users.username, username),
  });
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    await recordFailedAttempt(identifier);
    return NextResponse.json(
      { error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" },
      { status: 401 },
    );
  }

  /**
   * รหัสผ่านถูกแล้ว แต่บัญชีอาจยังใช้งานไม่ได้ (รออนุมัติ / ถูกเพิกถอน / สิทธิ์หมดอายุ)
   * เช็คหลังตรวจรหัสผ่าน เพื่อไม่ให้คนที่ไม่รู้รหัสผ่านใช้ endpoint นี้ไล่เดาว่ามีบัญชีไหนอยู่บ้าง
   * ไม่ออก session ให้เลย — resolveUserId ก็กันอีกชั้นเผื่อโดนเพิกถอนหลังล็อกอินไปแล้ว
   */
  const access = checkUserAccess(user);
  if (!access.usable) {
    await clearAttempts(identifier);
    return NextResponse.json({ error: access.message }, { status: 403 });
  }

  await clearAttempts(identifier);
  const res = NextResponse.json({ ok: true, username: user.username });
  res.cookies.set(SESSION_COOKIE, await createSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
