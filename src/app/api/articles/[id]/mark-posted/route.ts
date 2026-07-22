import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { getOwnedArticle } from "@/lib/ownership";

export const runtime = "nodejs";

/**
 * POST /api/articles/:id/mark-posted — ทำเครื่องหมายว่า "โพสเองแล้ว" (Manual Post)
 *
 * ใช้กับกรณีที่ผู้ใช้ไม่ได้ตั้ง Page ID/token แต่คัดลอกแคปชันไปวางบน Facebook เอง
 * ไม่ยิงอะไรไปหา Facebook ทั้งสิ้น — แค่เปลี่ยนสถานะเพื่อไม่ให้ค้างรกอยู่ในคิว
 *
 * แยกเป็น endpoint ต่างหากแทนการเปิดให้ PATCH เปลี่ยนสถานะเป็น "posted" ได้
 * เพราะเจตนาคนละเรื่องกัน — PATCH ควรคุมสถานะที่แก้ได้อย่างเข้มงวดต่อไป
 * ระเบียนที่โพสเองจะไม่มี fbPostId/fbPostUrl ซึ่งใช้แยกจากโพสต์ที่ยิงผ่าน API ได้
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ error: "id ไม่ถูกต้อง" }, { status: 400 });
  }

  const owned = await getOwnedArticle(userId, id);
  if (!owned) {
    return NextResponse.json({ error: "ไม่พบข่าวนี้" }, { status: 404 });
  }
  if (owned.article.status === "posted") {
    return NextResponse.json({ error: "ข่าวนี้ทำเครื่องหมายว่าโพสแล้ว" }, { status: 409 });
  }
  if (!owned.article.caption) {
    return NextResponse.json(
      { error: "ข่าวนี้ยังไม่มีแคปชัน — ไม่มีอะไรให้โพส" },
      { status: 400 },
    );
  }

  const [updated] = await db
    .update(articles)
    .set({ status: "posted", postedAt: new Date() })
    .where(eq(articles.id, id))
    .returning();

  return NextResponse.json({ article: updated });
}
