import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { isSettableStatus, setUserAccess } from "@/lib/admin";

export const runtime = "nodejs";

/**
 * PATCH /api/admin/users/:id — ปรับสถานะ / วันหมดอายุสิทธิ์ของบัญชีอื่น (เฉพาะผู้ดูแลระบบ)
 * body: { status?: "pending"|"active"|"revoked", accessExpiresAt?: string ISO | null }
 *
 * accessExpiresAt: ไม่ส่ง = ไม่แตะของเดิม, null = ใช้ได้ไม่มีกำหนด, ISO = ตั้งวันหมดอายุ
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

  let body: { status?: unknown; accessExpiresAt?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  if (body.status !== undefined && !isSettableStatus(body.status)) {
    return NextResponse.json({ error: "สถานะไม่ถูกต้อง" }, { status: 400 });
  }

  // แยก 3 กรณีให้ชัด: ไม่ส่งมา / ส่ง null / ส่งวันที่ — เพราะความหมายต่างกันหมด
  let accessExpiresAt: Date | null | undefined;
  if ("accessExpiresAt" in body) {
    if (body.accessExpiresAt === null) {
      accessExpiresAt = null;
    } else if (typeof body.accessExpiresAt === "string") {
      accessExpiresAt = new Date(body.accessExpiresAt);
    } else {
      return NextResponse.json({ error: "รูปแบบวันหมดอายุไม่ถูกต้อง" }, { status: 400 });
    }
  }

  const result = await setUserAccess({
    actorId: userId,
    targetId,
    status: body.status,
    accessExpiresAt,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ user: result.data });
}
