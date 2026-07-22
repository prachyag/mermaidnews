import { NextRequest, NextResponse } from "next/server";
import { createSession, getUserId, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/session";
import { changePassword } from "@/lib/account";
import {
  clearAttempts,
  clientIdentifier,
  isRateLimited,
  recordFailedAttempt,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * PATCH /api/account/password — เปลี่ยนรหัสผ่าน (ต้องยืนยันรหัสผ่านปัจจุบัน)
 * body: { currentPassword: string, newPassword: string }
 *
 * changePassword() เพิกถอน session ทุกอันรวมถึงเครื่องนี้ (ตั้งใจ — เตะอุปกรณ์อื่นออกจริง)
 * แล้วเราออก session ใหม่ให้เครื่องที่กดเปลี่ยนทันที คนที่ทำเองจึงไม่โดนเด้งออกกลางทาง
 */
export async function PATCH(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }

  const identifier = clientIdentifier(req);
  if (await isRateLimited(identifier)) {
    return NextResponse.json(
      { error: "พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" },
      { status: 429 },
    );
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const result = await changePassword({
    userId,
    currentPassword: body.currentPassword ?? "",
    newPassword: body.newPassword ?? "",
  });
  if (!result.ok) {
    if (result.status === 401) await recordFailedAttempt(identifier);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await clearAttempts(identifier);
  const res = NextResponse.json({
    ok: true,
    message: "เปลี่ยนรหัสผ่านแล้ว — อุปกรณ์อื่นที่ล็อกอินค้างไว้ถูกให้ออกจากระบบทั้งหมด",
  });
  res.cookies.set(SESSION_COOKIE, await createSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
