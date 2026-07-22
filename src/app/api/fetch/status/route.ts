import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { fetchRuns, topics } from "@/db/schema";
import { getUserId } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/fetch/status — สถานะรอบดึงล่าสุดของ user (ใช้ให้ปุ่ม Fetch Now แสดง progress) */
export async function GET(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const runs = await db
    .select({
      id: fetchRuns.id,
      topicId: fetchRuns.topicId,
      topicName: topics.name,
      trigger: fetchRuns.trigger,
      status: fetchRuns.status,
      startedAt: fetchRuns.startedAt,
      finishedAt: fetchRuns.finishedAt,
      found: fetchRuns.found,
      newCount: fetchRuns.newCount,
      duplicates: fetchRuns.duplicates,
      errorCount: fetchRuns.errorCount,
      errorMessage: fetchRuns.errorMessage,
    })
    .from(fetchRuns)
    .innerJoin(topics, eq(fetchRuns.topicId, topics.id))
    .where(eq(topics.userId, userId))
    .orderBy(desc(fetchRuns.startedAt))
    .limit(20);

  return NextResponse.json({
    anyRunning: runs.some((r) => r.status === "running"),
    runs,
  });
}
