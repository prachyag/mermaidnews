import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getOwnedTopic } from "@/lib/ownership";
import { isReprocessable, MAX_REPROCESS, reprocessArticles } from "@/lib/bulk-reprocess";

export const runtime = "nodejs";

/**
 * POST /api/articles/bulk-reprocess — สั่งประมวลผลใหม่ทีละหลายข่าว
 * body: { topicId?: number | "all", status?: "draft" | "irrelevant", limit?: number }
 *
 * ตัวนี้ "ไม่ได้เรียก AI" — แค่ตั้งสถานะกลับเป็นรอประมวลผล แล้ว client ค่อยเรียก
 * /api/process วนต่อเหมือนการประมวลผลปกติ จึงตอบกลับเร็วและไม่ชน timeout
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }

  let body: { topicId?: unknown; status?: unknown; limit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // ไม่มี body = ทุกหัวข้อ ทุกสถานะที่เข้าเกณฑ์
  }

  let topicId: number | "all" = "all";
  if (body.topicId !== undefined && body.topicId !== "all") {
    const parsed = Number(body.topicId);
    if (!Number.isInteger(parsed)) {
      return NextResponse.json({ error: "topicId ไม่ถูกต้อง" }, { status: 400 });
    }
    // ยืนยันความเป็นเจ้าของก่อน เพื่อให้ตอบ 404 ชัด ๆ แทนที่จะเงียบ ๆ ว่าไม่มีอะไรถูกแก้
    if (!(await getOwnedTopic(userId, parsed))) {
      return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
    }
    topicId = parsed;
  }

  if (body.status !== undefined && !isReprocessable(body.status)) {
    return NextResponse.json(
      { error: "สถานะนี้สั่งประมวลผลใหม่แบบหลายรายการไม่ได้" },
      { status: 400 },
    );
  }

  let limit = MAX_REPROCESS;
  if (body.limit !== undefined) {
    const parsed = Number(body.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return NextResponse.json({ error: "limit ไม่ถูกต้อง" }, { status: 400 });
    }
    limit = Math.min(parsed, MAX_REPROCESS);
  }

  const result = await reprocessArticles({
    userId,
    topicId,
    status: body.status,
    limit,
  });

  return NextResponse.json({ ...result, max: MAX_REPROCESS });
}
