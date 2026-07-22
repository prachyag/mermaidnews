import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { listAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/audit — ประวัติการกระทำของผู้ดูแลระบบ (เฉพาะผู้ดูแลระบบ) */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const entries = await listAuditLog(userId);
  if (entries === null) {
    return NextResponse.json({ error: "เฉพาะผู้ดูแลระบบเท่านั้น" }, { status: 403 });
  }
  return NextResponse.json({ entries });
}
