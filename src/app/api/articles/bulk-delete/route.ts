import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getOwnedTopic } from "@/lib/ownership";
import {
  BULK_DELETABLE,
  deleteArticlesByStatus,
  isBulkDeletable,
} from "@/lib/bulk-delete";

export const runtime = "nodejs";

/**
 * POST /api/articles/bulk-delete — ลบข่าวตามสถานะทีเดียวทั้งหมด (พร้อมบล็อกไม่ให้กลับมา)
 * body: { status: "irrelevant" | "rejected", topicId?: number | "all" }
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }

  let body: { status?: unknown; topicId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  if (!isBulkDeletable(body.status)) {
    return NextResponse.json(
      { error: `ลบทีเดียวทั้งหมดได้เฉพาะสถานะ: ${BULK_DELETABLE.join(", ")}` },
      { status: 400 },
    );
  }

  let topicId: number | "all" = "all";
  if (body.topicId !== undefined && body.topicId !== "all") {
    const parsed = Number(body.topicId);
    if (!Number.isInteger(parsed)) {
      return NextResponse.json({ error: "topicId ไม่ถูกต้อง" }, { status: 400 });
    }
    // เช็คความเป็นเจ้าของแยกต่างหาก เพื่อแยก "ไม่ใช่ของคุณ" ออกจาก "ไม่มีข่าวให้ลบ"
    if (!(await getOwnedTopic(userId, parsed))) {
      return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
    }
    topicId = parsed;
  }

  const result = await deleteArticlesByStatus({ userId, status: body.status, topicId });
  return NextResponse.json(result);
}
