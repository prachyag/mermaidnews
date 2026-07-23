import { and, count, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics } from "@/db/schema";
import { AI_MODEL_NAME, getAiProvider } from "./ai/gemini";
import type { ArticleAssessment } from "./ai/provider";
import { recordAiCall } from "./ai-stats";

type PendingArticle = {
  id: number;
  title: string;
  description: string | null;
  source: string | null;
  topicId: number;
  topicName: string;
  aiContext: string | null;
  captionStyle: string | null;
};

/**
 * เขียนผลประเมินของ AI ลงข่าวหนึ่งชิ้น — ใช้ร่วมกันทั้งทางเดินเดี่ยวและแบบชุด
 *
 * ล้าง content ทิ้งเสมอ เพราะรอบนี้เขียนแคปชันจากพาดหัว+เนื้อย่อของ RSS เท่านั้น
 * ถ้าปล่อยเนื้อข่าวเต็มค้างไว้ ระบบจะยังนึกว่าข่าวนี้ "ผ่านการอ่านเว็บจริงแล้ว"
 * ทั้งที่แคปชันปัจจุบันไม่ได้มาจากมัน (ดู isNull(content) ใน long-form.ts
 * และการย้อนสถานะใน api/articles/[id]/route.ts ที่ตัดสินจากค่านี้)
 */
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
            interestScore: result.interestScore,
            summary: result.summary,
            caption: result.caption,
            hashtags: result.hashtags,
            content: null,
          }
        : {
            status: "irrelevant",
            relevanceScore: result.relevanceScore,
            interestScore: result.interestScore,
            content: null,
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
  const startedAt = Date.now();
  const stat = {
    topicId: article.topicId,
    topicName: article.topicName,
    model: AI_MODEL_NAME,
    mode: "single" as const,
    requested: 1,
  };

  let result: ArticleAssessment;
  try {
    result = await provider.processArticle({
      topicName: article.topicName,
      aiContext: article.aiContext,
      captionStyle: article.captionStyle,
      title: article.title,
      description: article.description,
      source: article.source,
    });
  } catch (err) {
    await recordAiCall({
      ...stat,
      returned: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err; // ให้ route จัดการ error ต่อเหมือนเดิม — สถิติต้องไม่เปลี่ยนพฤติกรรม
  }

  await recordAiCall({
    ...stat,
    returned: 1,
    durationMs: Date.now() - startedAt,
    ok: true,
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
 *
 * เคยตั้ง 10 ตอนที่ยังปิด thinking ได้ แต่พอรุ่นใหม่บังคับให้มี thinking วัดผลจริงได้ว่า
 * ชุด 10 เริ่มไม่เสถียร (บางรอบโมเดลตอบกลับมาไม่ครบ เช่น 1 จาก 10) และช้า 15–30 วินาที
 * ขณะที่ชุด 5 ได้ครบทุกรอบและเร็วกว่ามาก (~4 วินาที) จึงลดค่าเริ่มต้นลงเพื่อความน่าเชื่อถือ
 * ข่าวที่โมเดลไม่ตอบกลับจะถูกทำเครื่องหมาย failed และคงสถานะ fetched ไว้ให้ประมวลผลซ้ำได้
 * ปรับได้ด้วย env GEMINI_BATCH_SIZE
 */
export const AI_BATCH_SIZE = Number(process.env.GEMINI_BATCH_SIZE) || 5;

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
    const startedAt = Date.now();
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

      // บันทึกสถิติ: returned < requested = AI ตอบไม่ครบ ซึ่งเป็นการเสื่อมที่ไม่ throw error
      await recordAiCall({
        topicId: head.topicId,
        topicName: head.topicName,
        model: AI_MODEL_NAME,
        mode: "batch",
        requested: batch.length,
        returned: results.length,
        durationMs: Date.now() - startedAt,
        ok: true,
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
      await recordAiCall({
        topicId: head.topicId,
        topicName: head.topicName,
        model: AI_MODEL_NAME,
        mode: "batch",
        requested: batch.length,
        returned: 0,
        durationMs: Date.now() - startedAt,
        ok: false,
        errorMessage: lastError,
      });
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
