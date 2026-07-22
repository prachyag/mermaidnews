import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, blockedArticles, type ArticleStatus } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { getOwnedArticle } from "@/lib/ownership";
import { normalizeTitle } from "@/lib/normalize";

export const runtime = "nodejs";

/** สถานะที่แอดมินเปลี่ยนเองได้จาก Dashboard (โพส/ตั้งเวลาเป็นหน้าที่ของ publish ในเฟส 4) */
const EDITABLE_STATUSES: ArticleStatus[] = [
  "fetched",
  "draft",
  "approved",
  "rejected",
];

/** PATCH /api/articles/:id — แก้แคปชัน/สรุป/แฮชแท็ก หรือเปลี่ยนสถานะ (อนุมัติ, ปฏิเสธ) */
export async function PATCH(
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
  if (!(await getOwnedArticle(userId, id))) {
    return NextResponse.json({ error: "ไม่พบข่าวนี้" }, { status: 404 });
  }

  let body: {
    caption?: string;
    summary?: string;
    hashtags?: string[];
    status?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const updates: Partial<typeof articles.$inferInsert> = {};
  if (typeof body.caption === "string") updates.caption = body.caption;
  if (typeof body.summary === "string") updates.summary = body.summary;
  if (Array.isArray(body.hashtags)) {
    updates.hashtags = body.hashtags.map((h) => String(h).trim()).filter(Boolean);
  }
  if (body.status !== undefined) {
    if (!EDITABLE_STATUSES.includes(body.status as ArticleStatus)) {
      return NextResponse.json(
        { error: `เปลี่ยนสถานะเป็น "${body.status}" จากหน้านี้ไม่ได้` },
        { status: 400 },
      );
    }
    updates.status = body.status as ArticleStatus;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "ไม่มีข้อมูลให้แก้ไข" }, { status: 400 });
  }

  const [updated] = await db
    .update(articles)
    .set(updates)
    .where(eq(articles.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "ไม่พบข่าวนี้" }, { status: 404 });
  }
  return NextResponse.json({ article: updated });
}

/**
 * DELETE /api/articles/:id — ลบข่าวถาวร แล้วบล็อกไม่ให้ถูกดึงกลับมาอีก
 *
 * ลบอย่างเดียวไม่พอ: ตัวกันซ้ำคือ unique(topicId,url) ซึ่งหายไปพร้อมแถวที่ลบ
 * ข่าวที่ยังอยู่ในฟีด RSS จึงกลับเข้ามาใหม่รอบหน้าได้ เลยต้องบันทึกลง
 * blocked_articles ไว้เป็น "ความจำ" ให้ตัวดึงข้ามข่าวนี้ตลอดไป
 *
 * ยังไม่แตะโพสต์บน Facebook — ถ้าข่าวนี้โพสไปแล้ว โพสต์ยังอยู่บนเพจ
 */
export async function DELETE(
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
  const { article } = owned;

  // บล็อกกับลบต้องสำเร็จหรือล้มเหลวไปด้วยกัน — ถ้าลบสำเร็จแต่บล็อกพลาด ข่าวจะกลับมา
  await db.transaction(async (tx) => {
    await tx
      .insert(blockedArticles)
      .values({
        topicId: article.topicId,
        url: article.url,
        titleKey: normalizeTitle(article.title),
        title: article.title,
      })
      .onConflictDoNothing();
    await tx.delete(articles).where(eq(articles.id, id));
  });

  return NextResponse.json({ ok: true });
}
