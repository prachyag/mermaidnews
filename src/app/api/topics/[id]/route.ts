import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, blockedArticles, fetchRuns, topics } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { getOwnedTopic } from "@/lib/ownership";
import { toTopicDTO } from "@/lib/topic-dto";
import { parseNewsSource } from "@/lib/news-source";

export const runtime = "nodejs";

/** PATCH /api/topics/:id — แก้ไขหัวข้อ / เปิด-ปิดการใช้งาน */
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
  if (!(await getOwnedTopic(userId, id))) {
    return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
  }

  let body: {
    name?: string;
    keywords?: string[];
    aiContext?: string | null;
    captionStyle?: string | null;
    fbPageId?: string | null;
    fbPageToken?: string;
    newsSource?: string;
    cronSchedule?: string;
    enabled?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const updates: Partial<typeof topics.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "ชื่อหัวข้อว่างไม่ได้" }, { status: 400 });
    updates.name = name;
  }
  if (body.keywords !== undefined) {
    const keywords = body.keywords.map((k) => String(k).trim()).filter(Boolean);
    if (keywords.length === 0) {
      return NextResponse.json(
        { error: "ต้องมี keyword อย่างน้อย 1 คำ" },
        { status: 400 },
      );
    }
    updates.keywords = keywords;
  }
  if (body.newsSource !== undefined) {
    const parsed = parseNewsSource(body.newsSource);
    if (parsed === null) {
      return NextResponse.json({ error: "ค่าแหล่งข่าวไม่ถูกต้อง" }, { status: 400 });
    }
    updates.newsSource = parsed;
  }
  if (body.aiContext !== undefined) updates.aiContext = body.aiContext?.trim() || null;
  if (body.captionStyle !== undefined)
    updates.captionStyle = body.captionStyle?.trim() || null;
  if (body.fbPageId !== undefined) updates.fbPageId = body.fbPageId?.trim() || null;
  // token: อัปเดตเฉพาะเมื่อผู้ใช้พิมพ์ค่าใหม่ (เว้นว่าง = คงค่าเดิม เพราะ client ไม่เคยได้ token กลับมา)
  if (body.fbPageToken !== undefined && body.fbPageToken.trim())
    updates.fbPageToken = body.fbPageToken.trim();
  if (body.cronSchedule !== undefined && body.cronSchedule.trim())
    updates.cronSchedule = body.cronSchedule.trim();
  if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "ไม่มีข้อมูลให้แก้ไข" }, { status: 400 });
  }

  const [updated] = await db
    .update(topics)
    .set(updates)
    .where(eq(topics.id, id))
    .returning();

  if (!updated) {
    return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
  }
  return NextResponse.json({ topic: toTopicDTO(updated) });
}

/** DELETE /api/topics/:id — ลบหัวข้อพร้อมข่าวและประวัติทั้งหมดใต้หัวข้อ */
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

  // ลบลูกก่อนกันกรณี foreign_keys pragma ไม่ได้เปิด (SQLite ไม่ enforce cascade เสมอ)
  await db.delete(articles).where(eq(articles.topicId, id));
  await db.delete(fetchRuns).where(eq(fetchRuns.topicId, id));
  await db.delete(blockedArticles).where(eq(blockedArticles.topicId, id));
  const deleted = await db.delete(topics).where(eq(topics.id, id)).returning();

  if (deleted.length === 0) {
    return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
