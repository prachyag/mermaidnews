/**
 * แคปชันแบบยาว — เลือกข่าวเด่น ไปอ่านเนื้อข่าวจากเว็บจริง แล้วให้ AI เขียนแคปชันเต็ม
 *
 * ทำไมต้องจำกัดจำนวน: การเขียนยาว 1 ข่าว = แกะลิงก์จริง 1 ครั้ง + โหลดหน้าเว็บ 1 ครั้ง
 * + เรียก AI 1 ครั้งด้วย prompt ที่ยาวกว่าปกติมาก (เนื้อข่าวเต็มถึง 6,000 ตัวอักษร)
 * ถ้าทำทุกข่าวจะช้าและกินโควตามหาศาล จึงทำเฉพาะข่าวที่คุ้มที่สุดไม่กี่ชิ้นต่อรอบ
 *
 * ทำไมต้องอ่านเว็บจริง: RSS ให้แค่พาดหัว + เนื้อหาย่อ ถ้าสั่ง AI เขียนยาวจากแค่นั้น
 * มันจะแต่งข้อมูลขึ้นมาเติมให้ครบความยาว ซึ่งรับไม่ได้สำหรับคอนเทนต์ข่าว
 */
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, type ArticleStatus } from "@/db/schema";
import { isDraftStatus } from "./article-status";
import { CONTENT_TIMEOUT_MS, fetchArticleContent } from "./article-content";
import { isGoogleNewsUrl, resolveArticleUrl, RESOLVE_TIMEOUT_MS } from "./resolve-url";
import { AI_MODEL_NAME, AI_TIMEOUT_MS, getAiProvider } from "./ai/gemini";
import { recordAiCall } from "./ai-stats";
import { MAX_LONG_FORM } from "./long-form-policy";

// นิยามจริงอยู่ใน long-form-policy.ts (ไฟล์ล้วน) เพื่อให้ฝั่ง client import ได้ด้วย
export { MAX_LONG_FORM } from "./long-form-policy";

/**
 * ดึงรายชื่อผู้สมัครมากกว่าที่ต้องการกี่เท่า
 * เพราะบางเว็บดึงเนื้อไม่ได้ (บล็อกบอท/paywall/เรนเดอร์ด้วย JS) ต้องมีตัวสำรองให้ข้ามไปเรื่อย ๆ
 * จนได้ครบตามจำนวนที่ขอ
 */
const CANDIDATE_MULTIPLIER = 4;

/**
 * เวลาที่แย่ที่สุดที่ข่าว 1 ชิ้นกินได้ — คำนวณจากเพดานจริงของแต่ละเฟส ไม่ได้ตั้งด้วยมือ
 *
 * แกะลิงก์ยิง Google 2 ครั้ง + โหลดหน้าเว็บ 1 ครั้ง + เรียก AI (รวมยิงซ้ำ) 1 ก้อน
 * ผูกกับค่าคงที่ของแต่ละโมดูลโดยตรง เพื่อให้วันที่ใครปรับเพดานฝั่งนั้น งบตรงนี้ขยับตามเอง
 */
export const WORST_ATTEMPT_MS =
  RESOLVE_TIMEOUT_MS * 2 + CONTENT_TIMEOUT_MS + AI_TIMEOUT_MS;

/**
 * เวลาที่ยอมให้ฟังก์ชันนี้ใช้ทั้งหมด — ต่ำกว่า maxDuration (60s) ไว้เผื่อ cold start
 * และเวลาที่เสียไปกับ auth/DB ก่อนถึงตรงนี้
 */
const DEFAULT_BUDGET_MS = 50_000;

export type LongFormOutcome = {
  articleId: number;
  title: string;
  ok: boolean;
  /** เหตุผลที่ข้าม (เมื่อ ok = false) */
  reason?: string;
  /** true = ไม่ได้ลองด้วยซ้ำเพราะเวลาจะหมด — ยังมีสิทธิ์ถูกเลือกใหม่รอบหน้า */
  outOfTime?: boolean;
};

export type LongFormResult = {
  /** จำนวนที่เขียนแคปชันยาวสำเร็จ */
  generated: number;
  /** จำนวนที่ถูกข้ามเพราะดึงเนื้อข่าวไม่ได้ */
  skipped: number;
  outcomes: LongFormOutcome[];
};

type Candidate = {
  id: number;
  title: string;
  url: string;
  resolvedUrl: string | null;
  description: string | null;
  source: string | null;
  status: ArticleStatus;
  topicId: number;
  topicName: string;
  aiContext: string | null;
  captionStyle: string | null;
};

/**
 * เลือกข่าวที่คุ้มจะเขียนยาวที่สุด — เรียงตามคะแนนความน่าสนใจที่ AI ให้ไว้
 *
 * เงื่อนไข: ต้องเป็นข่าวสถานะ draft (ผ่านการคัดกรองแล้วแต่ยังไม่ถูกอนุมัติ/โพส)
 * และยังไม่เคยดึงเนื้อข่าวมา (content เป็น null) เพื่อไม่ให้เลือกซ้ำตัวเดิมทุกรอบ
 *
 * ข่าวที่ AI ไม่ได้ให้ interestScore (ข้อมูลเก่าก่อนมีฟีเจอร์นี้) ถูกจัดท้ายแถวด้วย
 * COALESCE แต่ยังมีสิทธิ์ถูกเลือกถ้าไม่มีตัวเลือกอื่น
 */
export async function selectLongFormCandidates(input: {
  userId: number;
  topicId?: number | "all";
  limit: number;
  /**
   * ข่าวที่เพิ่งลองแล้วไม่สำเร็จในรอบก่อน ๆ ของการกดปุ่มครั้งเดียวกัน
   *
   * จำเป็นเพราะหน้าเว็บยิงทีละชิ้นหลายรอบ (กัน timeout) แต่ละรอบเป็นคำขออิสระที่ไม่มี
   * ความทรงจำร่วมกัน ถ้าไม่บอกว่าตัวไหนพังไปแล้ว รอบถัดไปจะหยิบตัวเดิมที่คะแนนสูงสุด
   * มาลองซ้ำจนครบทุกรอบ แล้วไม่ได้อะไรเลยสักชิ้น
   */
  excludeIds?: number[];
}): Promise<Candidate[]> {
  const conditions = [
    eq(topics.userId, input.userId),
    eq(articles.status, "draft"),
    isNull(articles.content),
  ];
  if (input.topicId !== undefined && input.topicId !== "all") {
    conditions.push(eq(articles.topicId, input.topicId));
  }
  if (input.excludeIds?.length) {
    conditions.push(notInArray(articles.id, input.excludeIds));
  }

  return db
    .select({
      id: articles.id,
      title: articles.title,
      url: articles.url,
      resolvedUrl: articles.resolvedUrl,
      description: articles.description,
      source: articles.source,
      status: articles.status,
      topicId: articles.topicId,
      topicName: topics.name,
      aiContext: topics.aiContext,
      captionStyle: topics.captionStyle,
    })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(...conditions))
    .orderBy(
      /**
       * ตัวที่เคยพังลงท้ายแถวก่อน แล้วค่อยเรียงตามคะแนนตามปกติ
       *
       * ต้องมาก่อนคะแนน เพราะเว็บที่บล็อกบอท/404 มักเป็นข่าวเด่นคะแนนสูง
       * ถ้าเรียงคะแนนก่อน มันจะลอยขึ้นหัวคิวมาขวางทุกครั้งที่กดปุ่ม
       * และในกลุ่มที่เคยพังด้วยกัน ให้ตัวที่พังนานแล้วได้ลองก่อน (เว็บอาจกลับมาแล้ว)
       */
      asc(sql`coalesce(${articles.longFormFailedAt}, 0)`),
      desc(sql`coalesce(${articles.interestScore}, -1)`),
      desc(articles.publishedAt),
      desc(articles.createdAt),
    )
    .limit(input.limit);
}

/** หา URL เว็บข่าวจริง (แกะจาก Google News ถ้าจำเป็น) แล้ว cache ไว้ */
async function ensureRealUrl(c: Candidate): Promise<string | null> {
  if (c.resolvedUrl) return c.resolvedUrl;
  if (!isGoogleNewsUrl(c.url)) return c.url;

  const resolved = await resolveArticleUrl(c.url);
  if (!resolved.ok) return null;
  await db
    .update(articles)
    .set({ resolvedUrl: resolved.url })
    .where(eq(articles.id, c.id));
  return resolved.url;
}

type Attempt = { ok: true } | { ok: false; reason: string };

/**
 * เขียนแคปชันยาว 1 ชิ้น แล้ว**บันทึกผลลัพธ์ลงเครื่องหมายเสมอ**
 *
 * ห่อ attemptLongCaption ไว้อีกชั้นแทนที่จะไปเติมโค้ดตามทางออกทุกจุด
 * เพราะทางที่ล้มเหลวมี 5 ทาง (แกะลิงก์ไม่ได้ / โหลดเว็บไม่ได้ / AI พัง / AI ว่าไม่เกี่ยว /
 * AI ไม่คืนแคปชัน) การไล่เติมทีละจุดคือรอวันลืมจุดใดจุดหนึ่งตอนเพิ่มเงื่อนไขใหม่
 */
async function writeLongCaption(c: Candidate): Promise<Attempt> {
  const res = await attemptLongCaption(c);
  await db
    .update(articles)
    // สำเร็จ = ล้างเครื่องหมายทิ้ง (เว็บกลับมาใช้ได้แล้ว ไม่ควรถูกลงโทษต่อ)
    .set({ longFormFailedAt: res.ok ? null : new Date() })
    .where(eq(articles.id, c.id));
  return res;
}

/**
 * เขียนแคปชันแบบยาวให้ข่าวหนึ่งชิ้น — คืน null ถ้าทำไม่ได้ (ผู้เรียกจะข้ามไปข่าวถัดไป)
 * ทุกความล้มเหลวถูกแปลงเป็นเหตุผลอ่านรู้เรื่อง ไม่ throw ออกไปล้มทั้งรอบ
 */
async function attemptLongCaption(c: Candidate): Promise<Attempt> {
  const realUrl = await ensureRealUrl(c);
  if (!realUrl) return { ok: false, reason: "แกะลิงก์เว็บข่าวจริงไม่สำเร็จ" };

  const content = await fetchArticleContent(realUrl);
  if (!content.ok) return { ok: false, reason: content.reason };

  const startedAt = Date.now();
  const stat = {
    topicId: c.topicId,
    topicName: c.topicName,
    model: AI_MODEL_NAME,
    mode: "single" as const,
    requested: 1,
  };

  try {
    const result = await getAiProvider().processArticle({
      topicName: c.topicName,
      aiContext: c.aiContext,
      captionStyle: c.captionStyle,
      title: c.title,
      description: c.description,
      source: c.source,
      content: content.text,
    });
    await recordAiCall({ ...stat, returned: 1, durationMs: Date.now() - startedAt, ok: true });

    // แยกสองกรณีให้ชัด ไม่งั้นผู้ใช้เข้าใจผิดว่าระบบพัง ทั้งที่ AI ตัดสินถูกแล้ว
    if (!result.relevant) {
      return { ok: false, reason: "AI อ่านเนื้อข่าวเต็มแล้วประเมินว่าไม่เกี่ยวข้องกับหัวข้อนี้" };
    }
    if (!result.caption) return { ok: false, reason: "AI ไม่ได้เขียนแคปชันกลับมา" };

    await db
      .update(articles)
      .set({
        caption: result.caption,
        summary: result.summary,
        hashtags: result.hashtags,
        // เก็บเนื้อข่าวไว้ = เครื่องหมายว่าทำแล้ว + สั่งเขียนใหม่ได้โดยไม่ต้องรบกวนเว็บต้นทางซ้ำ
        content: content.text,
        /**
         * แยกออกจากร่างปกติเพื่อให้เห็นด้วยตาว่าชิ้นไหนผ่านการอ่านเว็บจริงมาแล้ว
         *
         * ตั้งได้เฉพาะจากร่าง — ถ้าสั่งเขียนยาวให้ข่าวที่ "อนุมัติแล้ว" (ปุ่มรายชิ้นทำได้)
         * ห้ามดึงกลับมาเป็นร่าง ไม่งั้นการอนุมัติของคนจะถูกระบบถอนเงียบ ๆ
         */
        ...(isDraftStatus(c.status) ? { status: "draft_long" as const } : {}),
      })
      .where(eq(articles.id, c.id));
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordAiCall({
      ...stat,
      returned: 0,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorMessage: reason,
    });
    return { ok: false, reason };
  }
}

/**
 * เขียนแคปชันยาวให้ข่าวเด่นสูงสุด limit ชิ้น
 * ดึงผู้สมัครมาเผื่อ แล้ววนไปเรื่อย ๆ ข้ามตัวที่ดึงเนื้อไม่ได้ จนได้ครบหรือหมดผู้สมัคร
 */
export async function generateLongFormCaptions(input: {
  userId: number;
  topicId?: number | "all";
  limit?: number;
  excludeIds?: number[];
  /**
   * เวลาที่ยอมให้ "เริ่ม" ข่าวชิ้นใหม่ได้ นับจากเริ่มฟังก์ชัน
   *
   * ไม่ได้ตัดงานที่ทำค้างอยู่ (จะเสียของ) แค่ไม่เริ่มชิ้นใหม่เมื่อเวลาใกล้หมด
   * มีไว้กันชั้นสุดท้าย: คืนผลบางส่วนพร้อมเหตุผล ดีกว่าปล่อยให้ Vercel ตัดทิ้งทั้งคำขอ
   * แล้วผู้ใช้เห็นแค่ error โดยไม่รู้ว่ามีชิ้นไหนสำเร็จไปแล้วบ้าง
   */
  budgetMs?: number;
}): Promise<LongFormResult> {
  const startedAt = Date.now();
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const limit = Math.min(Math.max(1, input.limit ?? MAX_LONG_FORM), MAX_LONG_FORM);
  const candidates = await selectLongFormCandidates({
    userId: input.userId,
    topicId: input.topicId,
    limit: limit * CANDIDATE_MULTIPLIER,
    excludeIds: input.excludeIds,
  });

  const outcomes: LongFormOutcome[] = [];
  let generated = 0;

  for (const c of candidates) {
    if (generated >= limit) break;
    /**
     * ต้องเหลือเวลาพอสำหรับกรณีแย่ที่สุดของ "ทั้งชิ้น" ไม่ใช่แค่ยังไม่หมดงบ
     *
     * เช็คแค่ว่ายังไม่หมดงบคือที่มาของ FUNCTION_INVOCATION_TIMEOUT รอบล่าสุด:
     * เริ่มชิ้นใหม่ตอนวินาทีที่ 39 (ยังไม่ถึงงบ 40) แล้วชิ้นนั้นกินอีก 30 วิ = ทะลุ 60
     */
    if (Date.now() - startedAt + WORST_ATTEMPT_MS > budgetMs) {
      outcomes.push({
        articleId: c.id,
        title: c.title,
        ok: false,
        reason: "หยุดก่อนหมดเวลาของคำขอ — กดอีกครั้งเพื่อทำต่อ",
        outOfTime: true,
      });
      break;
    }
    const res = await writeLongCaption(c);
    if (res.ok) {
      generated++;
      outcomes.push({ articleId: c.id, title: c.title, ok: true });
    } else {
      outcomes.push({ articleId: c.id, title: c.title, ok: false, reason: res.reason });
    }
  }

  return { generated, skipped: outcomes.length - generated, outcomes };
}

/** เขียนแคปชันยาวให้ข่าวชิ้นเดียวที่ระบุ (ปุ่มสั่งเองรายข่าว) */
export async function generateLongFormForArticle(input: {
  userId: number;
  articleId: number;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const [c] = await db
    .select({
      id: articles.id,
      title: articles.title,
      url: articles.url,
      resolvedUrl: articles.resolvedUrl,
      description: articles.description,
      source: articles.source,
      status: articles.status,
      topicId: articles.topicId,
      topicName: topics.name,
      aiContext: topics.aiContext,
      captionStyle: topics.captionStyle,
    })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(eq(articles.id, input.articleId), eq(topics.userId, input.userId)))
    .limit(1);

  if (!c) return { ok: false, status: 404, error: "ไม่พบข่าวนี้" };

  const res = await writeLongCaption(c);
  return res.ok ? { ok: true } : { ok: false, status: 502, error: res.reason };
}

/** นับข่าวที่ยังเข้าเกณฑ์เขียนยาวได้ (ใช้โชว์บนปุ่ม) */
export async function countLongFormCandidates(input: {
  userId: number;
  topicId?: number | "all";
}): Promise<number> {
  const conditions = [
    eq(topics.userId, input.userId),
    eq(articles.status, "draft"),
    isNull(articles.content),
  ];
  if (input.topicId !== undefined && input.topicId !== "all") {
    conditions.push(eq(articles.topicId, input.topicId));
  }
  const rows = await db
    .select({ id: articles.id })
    .from(articles)
    .innerJoin(topics, eq(articles.topicId, topics.id))
    .where(and(...conditions));
  return rows.length;
}

/** ใช้ในเทส/สคริปต์: ล้างเครื่องหมายว่าเคยเขียนยาวแล้ว (ทั้งสำเร็จและล้มเหลว) */
export async function clearLongFormMark(articleIds: number[]): Promise<void> {
  if (articleIds.length === 0) return;
  await db
    .update(articles)
    .set({ content: null, longFormFailedAt: null })
    .where(inArray(articles.id, articleIds));
}
