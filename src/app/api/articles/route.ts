import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, type ArticleStatus } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { countArticlesByStatus } from "@/lib/article-counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/articles?topicId=&status= — รายการข่าวของ user ที่ล็อกอิน
 * คืน counts มาด้วยเสมอ (ยอดทุกสถานะในขอบเขตหัวข้อที่เลือก) เพื่อให้แท็บโชว์ตัวเลขได้
 * โดยไม่ต้องยิง request แยก
 */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const params = req.nextUrl.searchParams;
  const filters: SQL[] = [eq(topics.userId, userId)];

  let scopedTopicId: number | "all" = "all";
  const topicId = params.get("topicId");
  if (topicId && topicId !== "all") {
    const parsed = Number(topicId);
    if (!Number.isInteger(parsed)) {
      return NextResponse.json({ error: "topicId ไม่ถูกต้อง" }, { status: 400 });
    }
    filters.push(eq(articles.topicId, parsed));
    scopedTopicId = parsed;
  }

  const status = params.get("status");
  if (status && status !== "all") {
    filters.push(eq(articles.status, status as ArticleStatus));
  }

  const rows = await db
    .select({
      id: articles.id,
      topicId: articles.topicId,
      topicName: topics.name,
      title: articles.title,
      url: articles.url,
      resolvedUrl: articles.resolvedUrl,
      source: articles.source,
      publishedAt: articles.publishedAt,
      description: articles.description,
      status: articles.status,
      relevanceScore: articles.relevanceScore,
      summary: articles.summary,
      caption: articles.caption,
      hashtags: articles.hashtags,
      fbPostUrl: articles.fbPostUrl,
      postedAt: articles.postedAt,
      scheduledAt: articles.scheduledAt,
      createdAt: articles.createdAt,
    })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(...filters))
    .orderBy(desc(articles.publishedAt), desc(articles.createdAt))
    .limit(200);

  /**
   * ยอดแต่ละสถานะไม่ขึ้นกับแท็บที่เปิดอยู่ — ค่าเท่ากันหมดทุกแท็บในขอบเขตหัวข้อเดียวกัน
   * การสลับแท็บจึงไม่ต้องนับใหม่ ประหยัดการเดินทางไป-กลับฐานข้อมูล 1 รอบ (~130ms)
   * ซึ่งเป็นเวลาเกือบครึ่งของคำขอนี้ทั้งคำขอ
   *
   * client ส่ง counts=0 มาเมื่อเปลี่ยนแค่แท็บ และไม่ส่ง (= นับ) เมื่อเปลี่ยนหัวข้อ
   * หรือหลังมีการแก้ข้อมูลที่ทำให้ยอดเปลี่ยน
   */
  const counts =
    params.get("counts") === "0"
      ? undefined
      : await countArticlesByStatus({ userId, topicId: scopedTopicId });

  return NextResponse.json({ articles: rows, counts });
}
