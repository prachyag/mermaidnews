import { NextRequest, NextResponse, after } from "next/server";
import { getUserId } from "@/lib/session";
import { executeFetchRun, startFetch } from "@/lib/fetcher";
import { DEFAULT_FETCH_DAYS, MAX_FETCH_DAYS, parseFetchDays } from "@/lib/fetch-window";

export const runtime = "nodejs";

/**
 * POST /api/fetch — สั่งดึงข่าวทันที (ปุ่ม Fetch Now)
 * body: { topicId?: number | "all", days?: number }
 *
 * days = ดึงข่าวย้อนหลังกี่วัน (1–30, ไม่ระบุ = ค่าเริ่มต้น) — ดู src/lib/fetch-window.ts
 * ตอบกลับทันทีพร้อมรายการ run ที่เริ่ม — การดึงจริงทำงานเบื้องหลัง
 */
export async function POST(req: NextRequest) {
  const userId = await getUserId(req);
  if (userId === null) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  let topicId: number | "all" = "all";
  let days: number = DEFAULT_FETCH_DAYS;
  try {
    const body = await req.json();
    if (body.topicId !== undefined && body.topicId !== "all") {
      const parsed = Number(body.topicId);
      if (!Number.isInteger(parsed)) {
        return NextResponse.json({ error: "topicId ไม่ถูกต้อง" }, { status: 400 });
      }
      topicId = parsed;
    }
    const parsedDays = parseFetchDays(body.days);
    if (parsedDays === null) {
      return NextResponse.json(
        { error: `จำนวนวันย้อนหลังต้องเป็นจำนวนเต็ม 1–${MAX_FETCH_DAYS}` },
        { status: 400 },
      );
    }
    days = parsedDays;
  } catch {
    // ไม่มี body = ดึงทุกหัวข้อด้วยค่าเริ่มต้น
  }

  const { results, targets } = await startFetch(
    topicId === "all" ? "all" : [topicId],
    "manual",
    userId,
  );

  if (results.length === 0) {
    return NextResponse.json(
      { error: "ไม่พบหัวข้อที่ระบุ หรือยังไม่มีหัวข้อในระบบ" },
      { status: 404 },
    );
  }

  // ดึงจริงเบื้องหลังหลังตอบ response แล้ว (after รองรับทั้ง dev และ Vercel)
  after(async () => {
    for (const { runId, topic } of targets) {
      await executeFetchRun(runId, topic, days);
    }
  });

  return NextResponse.json({
    days,
    started: results
      .filter((r) => r.started)
      .map((r) => ({ runId: r.runId, topicId: r.topicId, topicName: r.topicName })),
    skipped: results
      .filter((r) => !r.started)
      .map((r) => ({ topicId: r.topicId, topicName: r.topicName, reason: r.reason })),
  });
}
