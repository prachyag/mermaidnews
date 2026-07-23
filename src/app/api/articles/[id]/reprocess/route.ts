import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { getOwnedArticle } from "@/lib/ownership";
import { processOneArticle } from "@/lib/processor";

export const runtime = "nodejs";

/** POST /api/articles/:id/reprocess — สั่ง AI ประมวลผลข่าวนี้ใหม่ทันที */
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
  const { article, topic } = owned;

  try {
    const result = await processOneArticle({
      id: article.id,
      title: article.title,
      description: article.description,
      source: article.source,
      topicId: topic.id,
      topicName: topic.name,
      aiContext: topic.aiContext,
      captionStyle: topic.captionStyle,
    });
    const [updated] = await db
      .select()
      .from(articles)
      .where(eq(articles.id, id));
    return NextResponse.json({ relevant: result.relevant, article: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
