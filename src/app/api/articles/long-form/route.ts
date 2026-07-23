import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getOwnedTopic } from "@/lib/ownership";
import { generateLongFormCaptions, MAX_LONG_FORM } from "@/lib/long-form";

export const runtime = "nodejs";

/**
 * แต่ละข่าวต้อง: แกะลิงก์จริง + โหลดหน้าเว็บ + เรียก AI ด้วย prompt ยาว
 * 5 ข่าวจึงใช้เวลาได้ถึงหลักสิบวินาที — ต้องขยายเพดานเวลาของฟังก์ชัน
 */
export const maxDuration = 60;

/**
 * POST /api/articles/long-form — เขียนแคปชันแบบยาวให้ข่าวเด่นสูงสุด 5 ชิ้น
 * body: { topicId?: number | "all", limit?: number }
 *
 * ระบบเลือกข่าวเองจากคะแนนความน่าสนใจที่ AI ให้ไว้ตอนคัดกรอง
 * ข่าวที่ดึงเนื้อจากเว็บไม่ได้จะถูกข้ามไปเลือกตัวถัดไปแทน
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }

  let body: { topicId?: unknown; limit?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // ไม่มี body = ทุกหัวข้อ จำนวนเต็มเพดาน
  }

  let topicId: number | "all" = "all";
  if (body.topicId !== undefined && body.topicId !== "all") {
    const parsed = Number(body.topicId);
    if (!Number.isInteger(parsed)) {
      return NextResponse.json({ error: "topicId ไม่ถูกต้อง" }, { status: 400 });
    }
    if (!(await getOwnedTopic(userId, parsed))) {
      return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
    }
    topicId = parsed;
  }

  let limit = MAX_LONG_FORM;
  if (body.limit !== undefined) {
    const parsed = Number(body.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return NextResponse.json({ error: "limit ไม่ถูกต้อง" }, { status: 400 });
    }
    limit = Math.min(parsed, MAX_LONG_FORM);
  }

  const result = await generateLongFormCaptions({ userId, topicId, limit });
  return NextResponse.json({ ...result, max: MAX_LONG_FORM });
}
