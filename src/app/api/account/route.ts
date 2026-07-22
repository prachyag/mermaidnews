import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getAccount, toAccountDTO } from "@/lib/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/account — ข้อมูลบัญชีของคนที่ล็อกอินอยู่ (ไม่มี passwordHash — ดู toAccountDTO) */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const user = await getAccount(userId);
  if (!user) {
    return NextResponse.json({ error: "ไม่พบบัญชีนี้" }, { status: 401 });
  }
  return NextResponse.json({ account: toAccountDTO(user) });
}
