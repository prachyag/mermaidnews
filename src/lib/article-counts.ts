import { and, count, eq, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, type ArticleStatus } from "@/db/schema";
import { STATUS_ORDER } from "@/lib/article-status";

/** จำนวนข่าวแยกตามสถานะ + ยอดรวม — ใช้โชว์ตัวเลขบนแท็บ */
export type ArticleCounts = Record<ArticleStatus, number> & { all: number };

/**
 * นับข่าวแยกตามสถานะ ในขอบเขตของบัญชี (และหัวข้อ ถ้าระบุ)
 *
 * จงใจ "ไม่" กรองตามสถานะ — ตัวเลขบนแท็บต้องเป็นยอดจริงของทุกสถานะ
 * ไม่ใช่ยอดของสถานะที่กำลังเลือกอยู่ (ไม่งั้นแท็บอื่นจะขึ้น 0 หมด)
 *
 * ใช้ GROUP BY ครั้งเดียว ไม่ยิงทีละสถานะ (กัน N+1)
 */
export async function countArticlesByStatus(input: {
  userId: number;
  topicId?: number | "all";
}): Promise<ArticleCounts> {
  const filters: SQL[] = [eq(topics.userId, input.userId)];
  if (input.topicId !== undefined && input.topicId !== "all") {
    filters.push(eq(articles.topicId, input.topicId));
  }

  const rows = await db
    .select({ status: articles.status, n: count() })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(...filters))
    .groupBy(articles.status);

  // เริ่มจาก 0 ทุกสถานะ — สถานะที่ไม่มีข่าวต้องเป็น 0 ไม่ใช่ undefined (แท็บจะได้ไม่ขึ้น NaN)
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as ArticleCounts;
  counts.all = 0;
  for (const row of rows) {
    counts[row.status] = row.n;
    counts.all += row.n;
  }
  return counts;
}
