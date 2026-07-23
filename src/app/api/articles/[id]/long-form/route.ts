import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { generateLongFormForArticle } from "@/lib/long-form";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/articles/:id/long-form — สั่งเขียนแคปชันแบบยาวให้ข่าวชิ้นนี้
 *
 * ปุ่มสั่งเองรายข่าว ใช้เมื่อ AI เลือกข่าวเด่นมาไม่ตรงใจ
 * ต่างจากการเลือกอัตโนมัติตรงที่สั่งซ้ำข่าวที่เคยเขียนยาวแล้วได้
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

  const result = await generateLongFormForArticle({ userId, articleId: id });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const [updated] = await db.select().from(articles).where(eq(articles.id, id));
  return NextResponse.json({ article: updated });
}
