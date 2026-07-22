/**
 * ownership helper รวมศูนย์ — กัน route ลืมเช็คว่า resource เป็นของ user ที่ล็อกอิน
 * ทุก route ที่แตะ topic/article รายตัวควรผ่านฟังก์ชันเหล่านี้แทนการเขียน query เอง
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, type Article, type Topic } from "@/db/schema";

/** คืนหัวข้อถ้าเป็นของ user นี้ — ไม่งั้น null */
export async function getOwnedTopic(
  userId: number,
  topicId: number,
): Promise<Topic | null> {
  const row = await db.query.topics.findFirst({
    where: and(eq(topics.id, topicId), eq(topics.userId, userId)),
  });
  return row ?? null;
}

/** คืนข่าว + หัวข้อของมัน ถ้าข่าวนี้อยู่ใต้หัวข้อของ user นี้ — ไม่งั้น null */
export async function getOwnedArticle(
  userId: number,
  articleId: number,
): Promise<{ article: Article; topic: Topic } | null> {
  const [row] = await db
    .select({ article: articles, topic: topics })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(eq(articles.id, articleId), eq(topics.userId, userId)));
  return row ?? null;
}
