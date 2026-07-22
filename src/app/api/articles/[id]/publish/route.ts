import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, type ArticleStatus } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { getOwnedArticle } from "@/lib/ownership";
import { FacebookError, publishToPage } from "@/lib/facebook";
import { isGoogleNewsUrl, resolveArticleUrl } from "@/lib/resolve-url";

export const runtime = "nodejs";

/** สถานะที่กดโพสได้: อนุมัติแล้ว, โพสล้มเหลว (retry), หรือ posted+force (ยืนยันโพสซ้ำ) */
const PUBLISHABLE: ArticleStatus[] = ["approved", "failed"];

/**
 * POST /api/articles/:id/publish — โพสลง Facebook Page ของหัวข้อ
 * body: { scheduledAt?: string (ISO — ถ้าระบุ = ตั้งเวลาโพส), force?: boolean }
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

  let body: { scheduledAt?: string; force?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // ไม่มี body = โพสทันที
  }

  const owned = await getOwnedArticle(userId, id);
  if (!owned) {
    return NextResponse.json({ error: "ไม่พบข่าวนี้" }, { status: 404 });
  }
  const { article, topic } = owned;

  if (article.status === "posted" && !body.force) {
    return NextResponse.json(
      { error: "ข่าวนี้โพสไปแล้ว — ถ้าต้องการโพสซ้ำต้องยืนยันอีกครั้ง (force)" },
      { status: 409 },
    );
  }
  if (article.status !== "posted" && !PUBLISHABLE.includes(article.status)) {
    return NextResponse.json(
      { error: `โพสได้เฉพาะข่าวที่อนุมัติแล้ว (สถานะปัจจุบัน: ${article.status})` },
      { status: 400 },
    );
  }
  if (!topic.fbPageId) {
    return NextResponse.json(
      {
        error: `หัวข้อ "${topic.name}" ยังไม่ได้ตั้ง Facebook Page ID — ตั้งได้ที่หน้าจัดการหัวข้อ`,
      },
      { status: 400 },
    );
  }
  if (!topic.fbPageToken) {
    return NextResponse.json(
      {
        error: `หัวข้อ "${topic.name}" ยังไม่ได้ตั้ง Facebook Page Access Token — ตั้งได้ที่หน้าจัดการหัวข้อ`,
      },
      { status: 400 },
    );
  }
  if (!article.caption) {
    return NextResponse.json(
      { error: "ข่าวนี้ยังไม่มีแคปชัน — แก้ไขแคปชันก่อนโพส" },
      { status: 400 },
    );
  }

  let scheduledAt: Date | undefined;
  if (body.scheduledAt) {
    scheduledAt = new Date(body.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      return NextResponse.json({ error: "รูปแบบเวลาไม่ถูกต้อง" }, { status: 400 });
    }
  }

  const hashtagLine =
    article.hashtags && article.hashtags.length > 0
      ? `\n\n${article.hashtags.join(" ")}`
      : "";
  const message = `${article.caption}${hashtagLine}`;

  /**
   * หาลิงก์ที่จะส่งให้ Facebook — ต้องเป็นลิงก์เว็บข่าวจริง ไม่ใช่ลิงก์ redirect ของ google
   * (ไม่งั้นการ์ดพรีวิวจะขึ้นว่า "Google News" + โลโก้ google ทุกโพสต์)
   *
   * ถ้าแกะไม่สำเร็จ: ไม่ล้มการโพส แต่ใช้ลิงก์เดิม (เท่าพฤติกรรมเดิม ไม่ถอยหลัง)
   * แล้วส่ง warning กลับไปบอกผู้ใช้ว่าโพสต์นี้จะได้การ์ดแบบไหน
   */
  let link = article.resolvedUrl ?? article.url;
  let warning: string | null = null;
  if (!article.resolvedUrl && isGoogleNewsUrl(article.url)) {
    const resolved = await resolveArticleUrl(article.url);
    if (resolved.ok) {
      link = resolved.url;
      // cache ไว้ ครั้งหน้าไม่ต้องแกะซ้ำ (retry / โพสซ้ำ / ปุ่มคัดลอก)
      await db.update(articles).set({ resolvedUrl: link }).where(eq(articles.id, id));
    } else {
      warning = `แกะลิงก์ข่าวจริงไม่สำเร็จ (${resolved.reason}) — โพสต์นี้จะขึ้นการ์ดพรีวิวเป็น "Google News" แทนพาดหัวข่าว`;
    }
  }

  try {
    const result = await publishToPage({
      pageId: topic.fbPageId,
      accessToken: topic.fbPageToken,
      message,
      link,
      scheduledAt,
    });

    const [updated] = await db
      .update(articles)
      .set(
        scheduledAt
          ? {
              status: "scheduled",
              scheduledAt,
              fbPostId: result.postId,
              fbPostUrl: result.postUrl,
            }
          : {
              status: "posted",
              postedAt: new Date(),
              fbPostId: result.postId,
              fbPostUrl: result.postUrl,
            },
      )
      .where(eq(articles.id, id))
      .returning();

    return NextResponse.json({ article: updated, warning });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // error ฝั่งตั้งค่า (config) ไม่นับเป็นโพสล้มเหลว — แจ้งเฉย ๆ ไม่เปลี่ยนสถานะ
    if (err instanceof FacebookError && err.kind === "config") {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    // Facebook ปฏิเสธหรือ network พัง — ทำเครื่องหมาย failed ให้กด retry ได้ (FR-5.4)
    if (article.status !== "posted") {
      await db.update(articles).set({ status: "failed" }).where(eq(articles.id, id));
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
