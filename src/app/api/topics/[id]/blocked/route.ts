import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { blockedArticles } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { getOwnedTopic } from "@/lib/ownership";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * รายการข่าวที่ถูกบล็อกของหัวข้อ — ทางออกสำหรับคนที่เผลอกดลบผิด
 * ถ้าไม่มีหน้านี้ การลบพลาดครั้งเดียวจะกันข่าวนั้นออกไปตลอดกาลโดยไม่มีทางกู้
 */

/** GET /api/topics/:id/blocked — ดูรายการที่บล็อกไว้ */
export async function GET(
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
  if (!(await getOwnedTopic(userId, id))) {
    return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: blockedArticles.id,
      title: blockedArticles.title,
      url: blockedArticles.url,
      createdAt: blockedArticles.createdAt,
    })
    .from(blockedArticles)
    .where(eq(blockedArticles.topicId, id))
    .orderBy(blockedArticles.createdAt);

  return NextResponse.json({ blocked: rows });
}

/**
 * DELETE /api/topics/:id/blocked — เลิกบล็อก
 * body: { blockedId?: number } — ระบุ = เลิกบล็อกรายการเดียว, ไม่ระบุ = ล้างทั้งหัวข้อ
 * ข่าวที่เลิกบล็อกจะกลับเข้ามาเองในรอบดึงถัดไป ถ้ายังอยู่ในฟีด RSS
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
  if (!(await getOwnedTopic(userId, id))) {
    return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
  }

  let body: { blockedId?: number } = {};
  try {
    body = await req.json();
  } catch {
    // ไม่มี body = ล้างทั้งหัวข้อ
  }

  // ผูก topicId ไว้ใน where เสมอ — กันไม่ให้ระบุ blockedId ของหัวข้อคนอื่นแล้วลบได้
  const where =
    body.blockedId !== undefined
      ? and(eq(blockedArticles.topicId, id), eq(blockedArticles.id, body.blockedId))
      : eq(blockedArticles.topicId, id);

  const removed = await db.delete(blockedArticles).where(where).returning({
    id: blockedArticles.id,
  });

  return NextResponse.json({ ok: true, removed: removed.length });
}
