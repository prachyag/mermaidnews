import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { articles, blockedArticles, topics, type ArticleStatus } from "@/db/schema";
import { normalizeTitle } from "@/lib/normalize";

/**
 * สถานะที่ลบทีเดียวทั้งหมดได้ — จงใจไม่ให้ลบ draft/approved/posted แบบยกเข่ง
 * เพราะพวกนั้นคือของที่ผู้ใช้ลงแรงไปแล้ว พลาดทีเดียวเสียหายหนัก
 */
export const BULK_DELETABLE: ArticleStatus[] = ["irrelevant", "rejected"];

export function isBulkDeletable(status: unknown): status is ArticleStatus {
  return BULK_DELETABLE.includes(status as ArticleStatus);
}

/** SQLite มีเพดานจำนวนพารามิเตอร์ต่อ statement — ซอยเป็นก้อนกันพังเมื่อข่าวเยอะ */
const CHUNK = 100;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * ลบข่าวตามสถานะทีเดียวทั้งหมด แล้วบล็อกไม่ให้ถูกดึงกลับมาอีก
 *
 * เหตุผลที่ต้องบล็อกด้วย (ไม่ใช่แค่ลบ): ข่าวที่ AI ตัดว่าไม่เกี่ยวข้อง ถ้าลบเฉย ๆ
 * รอบดึงถัดไปจะเก็บกลับมาแล้วส่งให้ AI ประเมินใหม่ = เผาโควตาซ้ำกับข่าวที่รู้คำตอบแล้ว
 *
 * ขอบเขตบัญชีบังคับผ่าน userId เสมอ — ข่าวของคนอื่นแตะไม่ได้แม้จะส่ง topicId มาตรง ๆ
 */
export async function deleteArticlesByStatus(input: {
  userId: number;
  status: ArticleStatus;
  /** จำกัดเฉพาะหัวข้อเดียว — undefined หรือ "all" = ทุกหัวข้อของบัญชีนี้ */
  topicId?: number | "all";
}): Promise<{ deleted: number }> {
  const conditions = [
    eq(articles.status, input.status),
    eq(topics.userId, input.userId),
  ];
  if (input.topicId !== undefined && input.topicId !== "all") {
    conditions.push(eq(articles.topicId, input.topicId));
  }

  // ดึงรายการที่จะลบก่อน — ต้องใช้ title/url ไปทำรายการบล็อก
  const targets = await db
    .select({
      id: articles.id,
      topicId: articles.topicId,
      title: articles.title,
      url: articles.url,
    })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(...conditions));

  if (targets.length === 0) return { deleted: 0 };

  // บล็อกกับลบต้องสำเร็จหรือล้มเหลวไปด้วยกัน — ถ้าลบสำเร็จแต่บล็อกพลาด ข่าวจะกลับมา
  await db.transaction(async (tx) => {
    for (const group of chunk(targets, CHUNK)) {
      await tx
        .insert(blockedArticles)
        .values(
          group.map((a) => ({
            topicId: a.topicId,
            url: a.url,
            titleKey: normalizeTitle(a.title),
            title: a.title,
          })),
        )
        .onConflictDoNothing();
      await tx.delete(articles).where(
        inArray(
          articles.id,
          group.map((a) => a.id),
        ),
      );
    }
  });

  return { deleted: targets.length };
}
