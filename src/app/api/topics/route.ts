import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { topics } from "@/db/schema";
import { getUserId } from "@/lib/session";
import { toTopicDTO } from "@/lib/topic-dto";
import { parseNewsSource } from "@/lib/news-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/topics — รายการหัวข้อของ user ที่ล็อกอินอยู่ (ตัด fbPageToken ออกก่อนส่ง) */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const rows = await db.query.topics.findMany({
    where: eq(topics.userId, userId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  return NextResponse.json({ topics: rows.map(toTopicDTO) });
}

/** POST /api/topics — สร้างหัวข้อใหม่ (เป็นของ user ที่ล็อกอิน) */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  let body: {
    name?: string;
    keywords?: string[];
    aiContext?: string;
    captionStyle?: string;
    fbPageId?: string;
    fbPageToken?: string;
    newsSource?: string;
    captionIncludeSummary?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const name = body.name?.trim();
  const keywords = (body.keywords ?? []).map((k) => k.trim()).filter(Boolean);
  if (!name || keywords.length === 0) {
    return NextResponse.json(
      { error: "ต้องระบุชื่อหัวข้อและ keyword อย่างน้อย 1 คำ" },
      { status: 400 },
    );
  }

  const newsSource = body.newsSource === undefined ? "auto" : parseNewsSource(body.newsSource);
  if (newsSource === null) {
    return NextResponse.json({ error: "ค่าแหล่งข่าวไม่ถูกต้อง" }, { status: 400 });
  }

  const [created] = await db
    .insert(topics)
    .values({
      userId,
      name,
      keywords,
      newsSource,
      aiContext: body.aiContext?.trim() || null,
      captionStyle: body.captionStyle?.trim() || null,
      captionIncludeSummary: body.captionIncludeSummary === true,
      fbPageId: body.fbPageId?.trim() || null,
      fbPageToken: body.fbPageToken?.trim() || null,
    })
    .returning();

  return NextResponse.json({ topic: toTopicDTO(created) }, { status: 201 });
}
