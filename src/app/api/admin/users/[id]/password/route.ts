import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { setUserPassword } from "@/lib/admin";

export const runtime = "nodejs";

/**
 * PATCH /api/admin/users/:id/password — ผู้ดูแลระบบตั้งรหัสผ่านใหม่ให้บัญชีอื่น
 * body: { newPassword: string }
 *
 * ไม่ต้องรู้รหัสผ่านเดิม (เป็นอำนาจ admin ใช้กรณีผู้ใช้ลืมรหัส) — DAL จะเตะ session
 * ของเจ้าของบัญชีออกให้ และห้าม admin ใช้ช่องทางนี้กับตัวเอง
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const targetId = Number((await params).id);
  if (!Number.isInteger(targetId)) {
    return NextResponse.json({ error: "id ไม่ถูกต้อง" }, { status: 400 });
  }

  let body: { newPassword?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const result = await setUserPassword({
    actorId: userId,
    targetId,
    newPassword: body.newPassword ?? "",
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    message: "ตั้งรหัสผ่านใหม่แล้ว — บัญชีนั้นถูกให้ออกจากระบบทุกอุปกรณ์",
  });
}
