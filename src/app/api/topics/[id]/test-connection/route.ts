import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/session";
import { getOwnedTopic } from "@/lib/ownership";
import { diagnoseConnection } from "@/lib/facebook";

export const runtime = "nodejs";

/**
 * POST /api/topics/:id/test-connection — ตรวจว่าหัวข้อนี้พร้อมโพสลง Facebook ไหม
 * อ่านอย่างเดียว ไม่โพสอะไรทั้งสิ้น และไม่ส่ง token กลับไปที่ client
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

  const topic = await getOwnedTopic(userId, id);
  if (!topic) {
    return NextResponse.json({ error: "ไม่พบหัวข้อนี้" }, { status: 404 });
  }

  const diagnosis = await diagnoseConnection({
    pageId: topic.fbPageId,
    accessToken: topic.fbPageToken,
  });

  return NextResponse.json({ diagnosis });
}
