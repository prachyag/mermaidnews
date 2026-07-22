import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { processPendingArticles } from "@/lib/processor";

export const runtime = "nodejs";

/**
 * ขยายเพดานเวลาของฟังก์ชันบน Vercel — 1 request ยิง AI แบบรวมชุด
 * ซึ่งใช้เวลาต่อครั้งนานกว่าการยิงทีละข่าว (default ของ Vercel คือ 10–15 วิ ซึ่งไม่พอ)
 */
export const maxDuration = 60;

/** เพดานข่าวต่อ 1 request — กันคนยิง limit สูงจนฟังก์ชัน timeout */
const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 10;

/**
 * POST /api/process — ประมวลผลข่าวที่ค้าง (สถานะ fetched) หนึ่งชุด
 * body: { topicId?: number | "all", limit?: number }
 * client เรียกวนซ้ำจนกว่า remaining จะเป็น 0
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  let topicId: number | "all" = "all";
  let limit = DEFAULT_LIMIT;
  try {
    const body = await req.json();
    if (body.topicId !== undefined && body.topicId !== "all") {
      const parsed = Number(body.topicId);
      if (!Number.isInteger(parsed)) {
        return NextResponse.json({ error: "topicId ไม่ถูกต้อง" }, { status: 400 });
      }
      topicId = parsed;
    }
    if (body.limit !== undefined) {
      const parsed = Number(body.limit);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LIMIT) limit = parsed;
    }
  } catch {
    // ไม่มี body = ประมวลผลทุกหัวข้อ
  }

  try {
    const result = await processPendingArticles(topicId, limit, userId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
