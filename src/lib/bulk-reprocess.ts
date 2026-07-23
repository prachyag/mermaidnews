/**
 * สั่งให้ AI ประมวลผลข่าวใหม่ทีละหลายชิ้น (แทนการกดทีละข่าว)
 *
 * วิธีทำงาน: **ไม่ได้เรียก AI เอง** แต่รีเซ็ตสถานะข่ากลับเป็น "fetched"
 * แล้วปล่อยให้ทางเดินประมวลผลเดิม (processPendingArticles + ลูปฝั่ง client) จัดการต่อ
 *
 * ทำไมออกแบบแบบนี้:
 * - ได้ทุกอย่างของทางเดิมฟรี ๆ — การรวมชุด, เว้นจังหวะกัน rate limit, บันทึกสถิติ, กัน timeout
 * - ถ้าเขียนทางประมวลผลคู่ขนานขึ้นมาใหม่ จะต้องดูแลสองทางให้ตรงกันตลอดไป
 * - รีเซ็ตสถานะเป็น DB op ที่เร็วมาก จบใน request เดียวได้แม้จำนวนมาก
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, type ArticleStatus } from "@/db/schema";
import { MAX_REPROCESS, REPROCESSABLE } from "./reprocess-policy";

// re-export เพื่อให้ที่เรียกเดิมยังใช้ path เดียวได้ (นิยามจริงอยู่ใน reprocess-policy.ts
// ซึ่งเป็นไฟล์ล้วน ไม่แตะ db จึงให้ฝั่ง client import ได้ด้วย)
export { MAX_REPROCESS, REPROCESSABLE, isReprocessable } from "./reprocess-policy";

export type ReprocessResult = {
  /** จำนวนที่ถูกตั้งกลับเป็น "รอประมวลผล" ในครั้งนี้ */
  queued: number;
  /** จำนวนที่เข้าเกณฑ์แต่ยังไม่ได้ทำในครั้งนี้ (เกินเพดาน) — กดซ้ำเพื่อทำต่อ */
  remaining: number;
};

/**
 * ตั้งข่าวที่เข้าเกณฑ์กลับเป็น "รอประมวลผล"
 *
 * จงใจ **ไม่ล้าง** caption/summary/hashtags เดิมทิ้ง เพราะถ้า AI ล้มเหลวกลางทาง
 * ผู้ใช้จะยังเหลือของเดิมไว้ใช้ ดีกว่าล้างทิ้งแล้วได้ข่าวเปล่า ๆ
 * เมื่อ AI สำเร็จ ค่าพวกนี้จะถูกเขียนทับด้วยผลใหม่อยู่แล้ว (ดู applyAssessment)
 */
export async function reprocessArticles(input: {
  userId: number;
  topicId?: number | "all";
  /** จำกัดเฉพาะสถานะเดียว — ไม่ระบุ = ทุกสถานะที่เข้าเกณฑ์ */
  status?: ArticleStatus;
  limit?: number;
}): Promise<ReprocessResult> {
  const limit = Math.min(Math.max(1, input.limit ?? MAX_REPROCESS), MAX_REPROCESS);

  const conditions = [
    eq(topics.userId, input.userId),
    input.status ? eq(articles.status, input.status) : inArray(articles.status, REPROCESSABLE),
  ];
  if (input.topicId !== undefined && input.topicId !== "all") {
    conditions.push(eq(articles.topicId, input.topicId));
  }
  const scope = and(...conditions);

  // หา id ที่จะทำก่อน (ต้อง join topics เพื่อ scope ตามเจ้าของ — update ตรง ๆ join ไม่ได้ใน SQLite)
  const rows = await db
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(scope)
    .orderBy(desc(articles.createdAt))
    .limit(limit);

  const [{ value: eligible }] = await db
    .select({ value: count() })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(scope);

  if (rows.length === 0) return { queued: 0, remaining: 0 };

  await db
    .update(articles)
    .set({ status: "fetched" })
    .where(inArray(articles.id, rows.map((r) => r.id)));

  return { queued: rows.length, remaining: Math.max(0, eligible - rows.length) };
}
