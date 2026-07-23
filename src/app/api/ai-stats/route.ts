import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { listRecentAiCalls, summarizeAiCalls } from "@/lib/ai-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/ai-stats?hours=24 — สุขภาพการเรียก AI
 *
 * ไม่ใช่ endpoint ของ admin โดยเฉพาะ: ผู้ใช้ทั่วไปดูของหัวข้อตัวเองได้
 * ส่วน admin เห็นทั้งระบบ (ขอบเขตบังคับใน DAL ไม่ใช่ที่นี่)
 */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }

  const raw = Number(req.nextUrl.searchParams.get("hours"));
  // จำกัดช่วงเวลาไม่ให้กวาดทั้งตาราง และกันค่าเพี้ยน (NaN/0/ติดลบ) ตกไปที่ค่าเริ่มต้น
  const sinceHours = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 24 * 30) : 24;

  const [summary, recent] = await Promise.all([
    summarizeAiCalls(userId, { sinceHours }),
    listRecentAiCalls(userId, { sinceHours, limit: 20 }),
  ]);

  return NextResponse.json({ sinceHours, summary, recent });
}
