import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, users } from "@/db/schema";
import type {
  AiProvider,
  ArticleAssessment,
  BatchAssessment,
  ProcessArticleInput,
  ProcessBatchInput,
} from "@/lib/ai/provider";

/**
 * เทสของ processPendingArticles — ตัวประมวลผลข่าวค้างด้วย AI แบบรวมชุด (batch)
 *
 * สิ่งที่ต้องไม่พังไม่ว่าจะ refactor ยังไง:
 * - ข่าวแต่ละชิ้นต้องได้ผลลัพธ์ "ของตัวเอง" ไม่สลับกัน  <- ความเสี่ยงหลักของ batching
 * - ข่าวที่ AI พัง/ไม่ตอบ ต้องคงสถานะ fetched ไว้ให้ลองใหม่ ไม่หายไปเงียบ ๆ
 * - ต้องไม่ข้ามขอบเขตบัญชี (userId) และหัวข้อ (topicId)
 * - ข่าวข้ามหัวข้อต้องไม่ถูกยัดในชุดเดียวกัน (บริบท AI ของแต่ละหัวข้อไม่เหมือนกัน)
 *
 * ใช้ฐานข้อมูลจริง (data/test.db สร้างจาก schema.ts) — mock แค่ตัว AI
 */

const mockProcessArticle = vi.fn<(input: ProcessArticleInput) => Promise<ArticleAssessment>>();
const mockProcessBatch = vi.fn<(input: ProcessBatchInput) => Promise<BatchAssessment[]>>();
vi.mock("@/lib/ai/gemini", () => ({
  getAiProvider: (): AiProvider => ({
    processArticle: mockProcessArticle,
    processArticleBatch: mockProcessBatch,
  }),
}));

const { processPendingArticles } = await import("@/lib/processor");
const { AI_CALL_DELAY_MS, AI_BATCH_SIZE } = await import("@/lib/processor");

function assessment(over: Partial<ArticleAssessment> = {}): ArticleAssessment {
  return {
    relevant: true,
    relevanceScore: 0.9,
    summary: "สรุป",
    caption: "แคปชัน",
    hashtags: ["#tag"],
    ...over,
  };
}

/** mock ของโมเดลที่ทำงานถูกต้อง: ตอบครบทุก id ที่ถูกขอ */
function batchReplyFrom(
  perArticle: (a: ProcessBatchInput["articles"][number]) => ArticleAssessment,
) {
  return async (input: ProcessBatchInput): Promise<BatchAssessment[]> =>
    input.articles.map((a) => ({ id: a.id, ...perArticle(a) }));
}

let userId: number;
let otherUserId: number;
let topicId: number;
let otherTopicId: number;

async function seedArticle(over: Partial<typeof articles.$inferInsert> = {}) {
  const [row] = await db
    .insert(articles)
    .values({
      topicId,
      title: "ข่าวทดสอบ",
      url: `https://example.com/${crypto.randomUUID()}`,
      status: "fetched",
      ...over,
    })
    .returning();
  return row;
}

const statusOf = async (id: number) =>
  (await db.query.articles.findFirst({ where: eq(articles.id, id) }))!;

beforeEach(async () => {
  vi.clearAllMocks();
  // ล้างข้อมูลทุกรอบ — เทสต้องไม่ขึ้นกับผลของเทสก่อนหน้า
  await db.delete(articles);
  await db.delete(topics);
  await db.delete(users);

  const [u] = await db
    .insert(users)
    .values({ username: `u-${crypto.randomUUID()}`, passwordHash: "x" })
    .returning();
  userId = u.id;
  const [other] = await db
    .insert(users)
    .values({ username: `o-${crypto.randomUUID()}`, passwordHash: "x" })
    .returning();
  otherUserId = other.id;

  const [t] = await db
    .insert(topics)
    .values({ userId, name: "นางเงือก", keywords: ["นางเงือก"], aiContext: "บริบท" })
    .returning();
  topicId = t.id;
  const [t2] = await db
    .insert(topics)
    .values({ userId: otherUserId, name: "ของคนอื่น", keywords: ["x"] })
    .returning();
  otherTopicId = t2.id;

  mockProcessBatch.mockImplementation(batchReplyFrom(() => assessment()));
});

describe("processPendingArticles — ผลลัพธ์ลงข่าวถูกชิ้น", () => {
  it("ข่าวที่เกี่ยวข้อง -> draft พร้อมแคปชัน/สรุป/แฮชแท็ก", async () => {
    const a = await seedArticle();
    mockProcessBatch.mockImplementation(
      batchReplyFrom(() =>
        assessment({ relevanceScore: 0.8, summary: "ส", caption: "ค", hashtags: ["#a", "#b"] }),
      ),
    );

    const result = await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect(result).toMatchObject({ processed: 1, drafted: 1, irrelevant: 0, failed: 0 });
    const row = await statusOf(a.id);
    expect(row.status).toBe("draft");
    expect(row.caption).toBe("ค");
    expect(row.summary).toBe("ส");
    expect(row.hashtags).toEqual(["#a", "#b"]);
    expect(row.relevanceScore).toBeCloseTo(0.8);
  });

  it("ข่าวที่ไม่เกี่ยวข้อง -> irrelevant และไม่เก็บแคปชัน", async () => {
    const a = await seedArticle();
    mockProcessBatch.mockImplementation(
      batchReplyFrom(() =>
        assessment({ relevant: false, relevanceScore: 0.1, caption: null, summary: null }),
      ),
    );

    const result = await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect(result).toMatchObject({ processed: 1, drafted: 0, irrelevant: 1 });
    const row = await statusOf(a.id);
    expect(row.status).toBe("irrelevant");
    expect(row.caption).toBeNull();
  });

  it("หลายข่าวในชุดเดียว: แต่ละชิ้นต้องได้ผลของตัวเอง ไม่สลับกัน", async () => {
    // หัวใจของการกัน regression ตอนทำ batching
    const a1 = await seedArticle({ title: "ข่าว A" });
    const a2 = await seedArticle({ title: "ข่าว B" });
    const a3 = await seedArticle({ title: "ข่าว C" });

    mockProcessBatch.mockImplementation(
      batchReplyFrom((a) => {
        if (a.title === "ข่าว A") return assessment({ caption: "แคปชันของ A" });
        if (a.title === "ข่าว B") return assessment({ relevant: false, caption: null });
        return assessment({ caption: "แคปชันของ C" });
      }),
    );

    await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect((await statusOf(a1.id)).caption).toBe("แคปชันของ A");
    expect((await statusOf(a2.id)).status).toBe("irrelevant");
    expect((await statusOf(a3.id)).caption).toBe("แคปชันของ C");
  });

  it("AI ตอบผลสลับลำดับ ต้องยังจับคู่ตาม id ได้ถูกชิ้น", async () => {
    const a1 = await seedArticle({ title: "ข่าว A" });
    const a2 = await seedArticle({ title: "ข่าว B" });

    // ตอบกลับแบบสลับลำดับ — ระบบต้องยึด id ไม่ใช่ลำดับในอาร์เรย์
    mockProcessBatch.mockImplementation(async (input) => {
      const byTitle = new Map(input.articles.map((a) => [a.title, a.id]));
      return [
        { id: byTitle.get("ข่าว B")!, ...assessment({ caption: "ของ B" }) },
        { id: byTitle.get("ข่าว A")!, ...assessment({ caption: "ของ A" }) },
      ];
    });

    await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect((await statusOf(a1.id)).caption).toBe("ของ A");
    expect((await statusOf(a2.id)).caption).toBe("ของ B");
  });

  it("AI ตอบ id ที่ไม่ได้ขอมา ต้องไม่ไปเขียนทับข่าวชิ้นอื่น", async () => {
    const target = await seedArticle({ title: "ในชุด" });
    const untouched = await seedArticle({ status: "draft", caption: "ห้ามแตะ" });

    mockProcessBatch.mockImplementation(async (input) => [
      { id: input.articles[0].id, ...assessment({ caption: "ผลที่ถูก" }) },
      { id: untouched.id, ...assessment({ caption: "ผลปลอมที่ไม่ได้ขอ" }) },
    ]);

    await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect((await statusOf(target.id)).caption).toBe("ผลที่ถูก");
    expect((await statusOf(untouched.id)).caption).toBe("ห้ามแตะ");
  });

  it("ส่งบริบทของหัวข้อ (topicName/aiContext) ไปให้ AI ครั้งเดียวต่อชุด", async () => {
    await seedArticle({ title: "พาดหัว", source: "สำนักข่าว" });

    await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect(mockProcessBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        topicName: "นางเงือก",
        aiContext: "บริบท",
        articles: [expect.objectContaining({ title: "พาดหัว", source: "สำนักข่าว" })],
      }),
    );
  });
});

describe("processPendingArticles — การรวมชุด (batching)", () => {
  it("ข่าวหลายชิ้นในหัวข้อเดียวกัน ยิง AI แค่ request เดียว (เหตุผลหลักของฟีเจอร์นี้)", async () => {
    for (let i = 0; i < 8; i++) await seedArticle();

    const result = await processPendingArticles(topicId, 10, userId, { delayMs: 0 });

    expect(result.processed).toBe(8);
    expect(result.drafted).toBe(8);
    expect(result.aiCalls).toBe(1); // 8 ข่าว = 1 request (เดิมคือ 8 requests)
    expect(mockProcessBatch).toHaveBeenCalledTimes(1);
    expect(mockProcessBatch.mock.calls[0][0].articles).toHaveLength(8);
  });

  it("ซอยเป็นหลายชุดตาม batchSize", async () => {
    for (let i = 0; i < 5; i++) await seedArticle();

    const result = await processPendingArticles(topicId, 10, userId, {
      delayMs: 0,
      batchSize: 2,
    });

    expect(result.aiCalls).toBe(3); // 5 ข่าว ชุดละ 2 = 2+2+1
    expect(mockProcessBatch.mock.calls.map((c) => c[0].articles.length)).toEqual([2, 2, 1]);
    expect(result.drafted).toBe(5);
  });

  it("ข่าวคนละหัวข้อต้องไม่อยู่ชุดเดียวกัน และแต่ละชุดได้บริบทของหัวข้อตัวเอง", async () => {
    // ถ้าเอาข่าวข้ามหัวข้อยัดชุดเดียวกัน AI จะประเมินด้วยเกณฑ์ผิดหัวข้อ
    const [t2] = await db
      .insert(topics)
      .values({ userId, name: "หัวข้อสอง", keywords: ["k"], aiContext: "บริบทสอง" })
      .returning();
    await seedArticle({ title: "ของหัวข้อหนึ่ง" });
    await db.insert(articles).values({
      topicId: t2.id,
      title: "ของหัวข้อสอง",
      url: "https://example.com/t2",
      status: "fetched",
    });

    await processPendingArticles("all", 10, userId, { delayMs: 0 });

    expect(mockProcessBatch).toHaveBeenCalledTimes(2);
    const calls = mockProcessBatch.mock.calls.map((c) => c[0]);
    const one = calls.find((c) => c.topicName === "นางเงือก")!;
    const two = calls.find((c) => c.topicName === "หัวข้อสอง")!;
    expect(one.aiContext).toBe("บริบท");
    expect(one.articles.map((a) => a.title)).toEqual(["ของหัวข้อหนึ่ง"]);
    expect(two.aiContext).toBe("บริบทสอง");
    expect(two.articles.map((a) => a.title)).toEqual(["ของหัวข้อสอง"]);
  });

  it("ค่า default ของ batch size ต้องมากกว่า 1 (ไม่งั้นกลับไปยิงทีละข่าวเงียบ ๆ)", () => {
    expect(AI_BATCH_SIZE).toBeGreaterThan(1);
  });
});

describe("processPendingArticles — การเลือกข่าวที่จะประมวลผล", () => {
  it("แตะเฉพาะข่าวสถานะ fetched ไม่ยุ่งกับข่าวที่ประมวลผลไปแล้ว", async () => {
    const draft = await seedArticle({ status: "draft", caption: "แคปชันเดิม" });
    const posted = await seedArticle({ status: "posted" });
    await seedArticle({ status: "fetched" });

    const result = await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect(result.processed).toBe(1);
    expect(mockProcessBatch.mock.calls[0][0].articles).toHaveLength(1);
    expect((await statusOf(draft.id)).caption).toBe("แคปชันเดิม");
    expect((await statusOf(posted.id)).status).toBe("posted");
  });

  it("limit จำกัดจำนวนต่อรอบ และ remaining บอกยอดที่เหลือ", async () => {
    for (let i = 0; i < 5; i++) await seedArticle();

    const result = await processPendingArticles(topicId, 2, userId, { delayMs: 0 });

    expect(result.processed).toBe(2);
    expect(result.remaining).toBe(3);
    expect(mockProcessBatch.mock.calls[0][0].articles).toHaveLength(2);
  });

  it("เรียกซ้ำจนหมด: remaining ต้องเดินลงจนเป็น 0 (loop ฝั่ง client พึ่งค่านี้หยุด)", async () => {
    for (let i = 0; i < 3; i++) await seedArticle();

    let last = await processPendingArticles(topicId, 2, userId, { delayMs: 0 });
    expect(last.remaining).toBe(1);
    last = await processPendingArticles(topicId, 2, userId, { delayMs: 0 });
    expect(last.remaining).toBe(0);
    expect(last.processed).toBe(1);
  });

  it("ไม่มีข่าวค้าง -> processed 0 และไม่เรียก AI เลย (กันเผาโควตาฟรี ๆ)", async () => {
    const result = await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect(result).toMatchObject({ processed: 0, remaining: 0, aiCalls: 0 });
    expect(mockProcessBatch).not.toHaveBeenCalled();
  });
});

describe("processPendingArticles — ขอบเขตบัญชีและหัวข้อ", () => {
  it("ไม่ประมวลผลข่าวของบัญชีอื่น", async () => {
    const mine = await seedArticle();
    const [theirs] = await db
      .insert(articles)
      .values({
        topicId: otherTopicId,
        title: "ข่าวคนอื่น",
        url: "https://example.com/theirs",
        status: "fetched",
      })
      .returning();

    const result = await processPendingArticles("all", 10, userId, { delayMs: 0 });

    expect(result.processed).toBe(1);
    expect((await statusOf(mine.id)).status).toBe("draft");
    expect((await statusOf(theirs.id)).status).toBe("fetched");
  });

  it("ระบุ topicId -> ไม่แตะหัวข้ออื่นของบัญชีเดียวกัน", async () => {
    const [t2] = await db
      .insert(topics)
      .values({ userId, name: "หัวข้อสอง", keywords: ["k"] })
      .returning();
    const inTopic = await seedArticle();
    const [outTopic] = await db
      .insert(articles)
      .values({
        topicId: t2.id,
        title: "อีกหัวข้อ",
        url: "https://example.com/other-topic",
        status: "fetched",
      })
      .returning();

    await processPendingArticles(topicId, 10, userId, { delayMs: 0 });

    expect((await statusOf(inTopic.id)).status).toBe("draft");
    expect((await statusOf(outTopic.id)).status).toBe("fetched");
  });
});

describe("การเว้นจังหวะเรียก AI", () => {
  it("ค่า default ต้องยังเว้นจังหวะจริง (delayMs: 0 มีไว้ให้เทสเท่านั้น)", () => {
    // กัน pacing หายไปเงียบ ๆ เพราะเผลอปล่อย default เป็น 0 แล้วไปชน rate limit บนของจริง
    expect(AI_CALL_DELAY_MS).toBeGreaterThan(0);
  });

  it("หน่วงระหว่างชุด ไม่หน่วงก่อนชุดแรก", async () => {
    for (let i = 0; i < 2; i++) await seedArticle();

    const started = Date.now();
    await processPendingArticles(topicId, 2, userId, { delayMs: 50, batchSize: 1 });
    const elapsed = Date.now() - started;

    // 2 ชุด = หน่วง 1 ครั้ง (ไม่ใช่ 2) — ถ้าหน่วงก่อนชุดแรกด้วยจะเสียเวลาฟรี
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(150);
  });

  it("ชุดเดียวไม่ต้องหน่วงเลย", async () => {
    for (let i = 0; i < 5; i++) await seedArticle();

    const started = Date.now();
    await processPendingArticles(topicId, 5, userId, { delayMs: 500 });

    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("processPendingArticles — เมื่อ AI พัง", () => {
  it("ทั้งชุดพัง -> ทุกชิ้นคงสถานะ fetched ไว้ให้ลองใหม่ ไม่หายไปเงียบ ๆ", async () => {
    const a1 = await seedArticle();
    const a2 = await seedArticle();
    mockProcessBatch.mockRejectedValue(new Error("429 Too Many Requests"));

    const result = await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect(result).toMatchObject({ processed: 2, failed: 2, drafted: 0 });
    expect(result.lastError).toContain("429");
    expect((await statusOf(a1.id)).status).toBe("fetched");
    expect((await statusOf(a2.id)).status).toBe("fetched");
    expect(result.remaining).toBe(2); // ยังนับเป็นงานค้าง
  });

  it("AI ข้ามข่าวบางชิ้น -> เฉพาะชิ้นที่ถูกข้ามเป็น failed ชิ้นอื่นยังสำเร็จ", async () => {
    // ความเสี่ยงเฉพาะของ batching: โมเดลตอบไม่ครบตามจำนวนที่ขอ
    const ok = await seedArticle({ title: "ตอบ" });
    const skipped = await seedArticle({ title: "ถูกข้าม" });

    mockProcessBatch.mockImplementation(async (input) =>
      input.articles
        .filter((a) => a.title !== "ถูกข้าม")
        .map((a) => ({ id: a.id, ...assessment() })),
    );

    const result = await processPendingArticles(topicId, 5, userId, { delayMs: 0 });

    expect(result).toMatchObject({ processed: 2, drafted: 1, failed: 1 });
    expect(result.lastError).toContain("ไม่ได้ตอบผลของข่าว");
    expect((await statusOf(ok.id)).status).toBe("draft");
    expect((await statusOf(skipped.id)).status).toBe("fetched");
  });

  it("ชุดหนึ่งพัง ต้องไม่ทำให้ชุดอื่นในรอบเดียวกันพังตาม", async () => {
    const a1 = await seedArticle({ title: "ชุดดี" });
    const a2 = await seedArticle({ title: "ชุดพัง" });

    mockProcessBatch.mockImplementation(async (input) => {
      if (input.articles[0].title === "ชุดพัง") throw new Error("AI ล่ม");
      return input.articles.map((a) => ({ id: a.id, ...assessment() }));
    });

    const result = await processPendingArticles(topicId, 5, userId, {
      delayMs: 0,
      batchSize: 1,
    });

    expect(result).toMatchObject({ processed: 2, drafted: 1, failed: 1 });
    expect((await statusOf(a1.id)).status).toBe("draft");
    expect((await statusOf(a2.id)).status).toBe("fetched");
  });
});
