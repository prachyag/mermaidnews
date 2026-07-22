import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { getOwnedArticle } from "@/lib/ownership";
import { isGoogleNewsUrl, resolveArticleUrl } from "@/lib/resolve-url";

export const runtime = "nodejs";

/**
 * POST /api/articles/:id/resolve-url — แกะลิงก์เว็บข่าวจริงแล้ว cache ไว้
 *
 * ใช้กับปุ่ม "คัดลอกโพสต์" ของคนที่โพสเอง — ต้องได้ลิงก์จริงไปวาง ไม่งั้น
 * Facebook จะขึ้นการ์ด "Google News" เหมือนกับตอนโพสผ่าน API
 *
 * ตอบ 200 เสมอถ้าข่าวเป็นของผู้ใช้ — แกะไม่ได้ก็คืนลิงก์เดิมพร้อม warning
 * เพราะการคัดลอกต้องใช้งานได้เสมอ ไม่ควรพังเพราะ Google
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
  const { article } = owned;

  if (article.resolvedUrl) {
    return NextResponse.json({ url: article.resolvedUrl, cached: true });
  }
  if (!isGoogleNewsUrl(article.url)) {
    return NextResponse.json({ url: article.url });
  }

  const resolved = await resolveArticleUrl(article.url);
  if (!resolved.ok) {
    return NextResponse.json({
      url: article.url,
      warning: `แกะลิงก์ข่าวจริงไม่สำเร็จ (${resolved.reason}) — ลิงก์ที่คัดลอกจะขึ้นการ์ดพรีวิวเป็น "Google News"`,
    });
  }

  await db.update(articles).set({ resolvedUrl: resolved.url }).where(eq(articles.id, id));
  return NextResponse.json({ url: resolved.url });
}
