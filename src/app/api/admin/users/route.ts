import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { listUsers } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/users — รายชื่อผู้ใช้ทั้งหมด (เฉพาะผู้ดูแลระบบ) */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const result = await listUsers(userId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ users: result.data });
}
