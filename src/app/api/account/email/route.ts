import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { changeEmail, getAccount, toAccountDTO } from "@/lib/account";
import {
  clearAttempts,
  clientIdentifier,
  isRateLimited,
  recordFailedAttempt,
} from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * PATCH /api/account/email — เปลี่ยนอีเมล (ต้องยืนยันรหัสผ่านปัจจุบัน)
 * body: { currentPassword: string, email: string }
 *
 * มี rate limit เพราะ endpoint นี้ตรวจรหัสผ่าน = เดารหัสผ่านรัวได้เหมือนหน้าล็อกอิน
 * (ต่างกันแค่ต้องมี session ก่อน ซึ่งกันคนนอกได้ แต่ไม่กันคนที่ยืมเครื่องเปิดทิ้งไว้)
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

  let body: { currentPassword?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const result = await changeEmail({
    userId,
    currentPassword: body.currentPassword ?? "",
    newEmail: body.email ?? "",
  });
  if (!result.ok) {
    if (result.status === 401) await recordFailedAttempt(identifier);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await clearAttempts(identifier);
  const user = await getAccount(userId);
  return NextResponse.json({ ok: true, account: user ? toAccountDTO(user) : null });
}
