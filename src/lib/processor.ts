import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics } from "@/db/schema";
import { getAiProvider } from "./ai/gemini";
import type { ArticleAssessment } from "./ai/provider";

type PendingArticle = {
  id: number;
  title: string;
  description: string | null;
  source: string | null;
  topicName: string;
  aiContext: string | null;
  captionStyle: string | null;
};

/** เขียนผลประเมินของ AI ลงข่าวหนึ่งชิ้น — ใช้ร่วมกันทั้งทางเดินเดี่ยวและแบบชุด */
async function applyAssessment(
  articleId: number,
  result: ArticleAssessment,
): Promise<void> {
  await db
    .update(articles)
    .set(
      result.relevant
        ? {
            status: "draft",
            relevanceScore: result.relevanceScore,
            summary: result.summary,
            caption: result.caption,
            hashtags: result.hashtags,
          }
        : {
            status: "irrelevant",
            relevanceScore: result.relevanceScore,
          },
    )
    .where(eq(articles.id, articleId));
}

/**
 * ประมวลผลข่าวชิ้นเดียว: เรียก AI แล้วอัปเดตสถานะ/แคปชันลงฐานข้อมูล
 * ใช้กับปุ่ม "ให้ AI ประมวลผลใหม่" รายข่าว (การประมวลผลจำนวนมากใช้แบบชุด)
 */
export async function processOneArticle(
  article: PendingArticle,
): Promise<{ relevant: boolean }> {
  const provider = getAiProvider();
  const result = await provider.processArticle({
    topicName: article.topicName,
    aiContext: article.aiContext,
    captionStyle: article.captionStyle,
    title: article.title,
    description: article.description,
    source: article.source,
  });

  await applyAssessment(article.id, result);
  return { relevant: result.relevant };
}

export type ProcessResult = {
  /** จำนวนที่พยายามประมวลผลในรอบนี้ */
  processed: number;
  drafted: number;
  irrelevant: number;
  failed: number;
  /** ข่าวสถานะ fetched ที่ยังค้างอยู่หลังจบรอบ */
  remaining: number;
  lastError: string | null;
  /** จำนวน request ที่ยิงไปหา AI จริงในรอบนี้ — ใช้ดูว่าประหยัดโควตาได้แค่ไหน */
  aiCalls: number;
};

/**
 * จังหวะหน่วงระหว่างเรียก AI แต่ละครั้ง กันชน rate limit ของ Gemini free tier
 * (ค่านี้เป็นการเดา ไม่ได้อิงตัวเลขจริงจาก Google — ดูโควตาจริงได้ที่ AI Studio)
 */
export const AI_CALL_DELAY_MS = 4000;

/**
 * จำนวนข่าวต่อ 1 request ที่ส่งให้ AI
 *
 * ยิ่งมากยิ่งประหยัดโควตา (RPD/RPM) แต่แลกมาด้วย 3 ความเสี่ยง:
 * โมเดลสับสนระหว่างข่าว, output ยาวจนโดนตัดกลางคัน, และถ้าชุดพังก็พังทั้งชุด
 * 10 เป็นจุดที่สมดุล — ปรับได้ด้วย env GEMINI_BATCH_SIZE
 */
export const AI_BATCH_SIZE = Number(process.env.GEMINI_BATCH_SIZE) || 10;

/**
 * ประมวลผลข่าวสถานะ fetched — รวมหลายข่าวต่อ 1 request เพื่อประหยัดโควตา AI
 *
 * ทำไมต้องจัดกลุ่มตามหัวข้อก่อน: บริบทที่ส่งให้ AI (ชื่อหัวข้อ/เกณฑ์ความเกี่ยวข้อง/
 * สไตล์แคปชัน) เป็นของแต่ละหัวข้อ ชุดเดียวจึงมีข่าวข้ามหัวข้อปนกันไม่ได้
 *
 * ออกแบบให้เรียกซ้ำจนกว่า remaining จะเป็น 0 เพื่อไม่ให้ request เดียวรันนาน
 * เกิน timeout ของ serverless
 *
 * delayMs/batchSize เปิดไว้ให้เทสสั่งค่าอื่นได้ (ไม่งั้นเทสต้องนั่งรอจริง ๆ)
 */
export async function processPendingArticles(
  topicId: number | "all",
  limit = 10,
  userId?: number,
  {
    delayMs = AI_CALL_DELAY_MS,
    batchSize = AI_BATCH_SIZE,
  }: { delayMs?: number; batchSize?: number } = {},
): Promise<ProcessResult> {
  const conditions = [eq(articles.status, "fetched")];
  if (topicId !== "all") conditions.push(eq(articles.topicId, topicId));
  if (userId !== undefined) conditions.push(eq(topics.userId, userId));
  const scope = and(...conditions);

  const pending = await db
    .select({
      id: articles.id,
      topicId: articles.topicId,
      title: articles.title,
      description: articles.description,
      source: articles.source,
      topicName: topics.name,
      aiContext: topics.aiContext,
      captionStyle: topics.captionStyle,
    })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(scope)
    .orderBy(desc(articles.createdAt))
    .limit(limit);

  // จัดกลุ่มตามหัวข้อก่อน แล้วค่อยซอยแต่ละกลุ่มเป็นชุดละ batchSize
  const byTopic = new Map<number, typeof pending>();
  for (const row of pending) {
    const group = byTopic.get(row.topicId);
    if (group) group.push(row);
    else byTopic.set(row.topicId, [row]);
  }
  const batches: (typeof pending)[] = [];
  for (const group of byTopic.values()) {
    for (let i = 0; i < group.length; i += batchSize) {
      batches.push(group.slice(i, i + batchSize));
    }
  }

  let drafted = 0;
  let irrelevant = 0;
  let failed = 0;
  let aiCalls = 0;
  let lastError: string | null = null;

  const provider = getAiProvider();

  for (const [index, batch] of batches.entries()) {
    // เว้นจังหวะระหว่าง request ให้อยู่ใน rate limit ของ Gemini free tier
    if (index > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));

    const head = batch[0];
    try {
      aiCalls++;
      const results = await provider.processArticleBatch({
        topicName: head.topicName,
        aiContext: head.aiContext,
        captionStyle: head.captionStyle,
        articles: batch.map((a) => ({
          id: a.id,
          title: a.title,
          description: a.description,
          source: a.source,
        })),
      });

      const byId = new Map(results.map((r) => [r.id, r]));
      for (const article of batch) {
        const result = byId.get(article.id);
        // AI ไม่ตอบผลของข่าวชิ้นนี้ (ข้ามไป หรือตอบ id ที่ไม่ได้ขอ) — คงสถานะ fetched ให้ลองใหม่
        if (!result) {
          failed++;
          lastError = `AI ไม่ได้ตอบผลของข่าว id=${article.id} กลับมา`;
          continue;
        }
        await applyAssessment(article.id, result);
        if (result.relevant) drafted++;
        else irrelevant++;
      }
    } catch (err) {
      // ทั้งชุดพัง — คงสถานะ fetched ไว้ทุกชิ้นให้ประมวลผลซ้ำได้ (FR-3.4)
      failed += batch.length;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`ประมวลผลชุด ${batch.length} ข่าวล้มเหลว:`, lastError);
    }
  }

  const [{ value: remaining }] = await db
    .select({ value: count() })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(scope);

  return {
    processed: pending.length,
    drafted,
    irrelevant,
    failed,
    remaining,
    lastError,
    aiCalls,
  };
}
