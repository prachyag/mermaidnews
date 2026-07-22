import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { setUserRole } from "@/lib/admin";
import type { UserRole } from "@/db/schema";

export const runtime = "nodejs";

/**
 * PATCH /api/admin/users/:id/role — เลื่อนขั้น/ลดขั้นผู้ดูแลระบบ (เฉพาะผู้ดูแลระบบ)
 * body: { role: "admin" | "user" }
 *
 * ทางออกฉุกเฉินเมื่อ admin เดิมหาย/ลืมรหัส — DAL กันลดขั้นตัวเองและลด admin คนสุดท้ายไว้แล้ว
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

  let body: { role?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }
  if (body.role !== "admin" && body.role !== "user") {
    return NextResponse.json({ error: "สิทธิ์ไม่ถูกต้อง" }, { status: 400 });
  }

  const result = await setUserRole({
    actorId: userId,
    targetId,
    role: body.role as UserRole,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ user: result.data });
}
