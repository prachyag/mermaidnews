import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, users, type ArticleStatus } from "@/db/schema";
import { hashPassword } from "./password";
import type { ArticleAssessment } from "./ai/provider";

const mockFetchContent = vi.fn();
const mockResolve = vi.fn();
const mockProcessArticle = vi.fn();

/*
 * ค่าเพดานเวลาของแต่ละโมดูลต้องใส่ใน mock ด้วย เพราะ long-form เอาไปคำนวณงบเวลารวม
 * ถ้าลืม จะได้ NaN แล้วตัวกันเวลาหมดจะเงียบไปเฉย ๆ โดยเทสไม่ฟ้อง (vitest ฟ้องให้แล้วรอบนี้)
 */
vi.mock("@/lib/article-content", () => ({
  fetchArticleContent: (...a: unknown[]) => mockFetchContent(...a),
  MAX_CONTENT_CHARS: 6000,
  CONTENT_TIMEOUT_MS: 8_000,
}));

vi.mock("@/lib/resolve-url", () => ({
  isGoogleNewsUrl: (u: string) => u.includes("news.google.com"),
  resolveArticleUrl: (...a: unknown[]) => mockResolve(...a),
  RESOLVE_TIMEOUT_MS: 6_000,
}));

vi.mock("@/lib/ai/gemini", () => ({
  AI_MODEL_NAME: "test-model",
  // long-form ใช้ค่านี้คำนวณงบเวลา — ถ้าลืมใส่ จะได้ NaN แล้วตัวกันเวลาหมดจะไม่ทำงานเงียบ ๆ
  AI_TIMEOUT_MS: 20_000,
  getAiProvider: () => ({
    processArticle: (...a: unknown[]) => mockProcessArticle(...a),
    processArticleBatch: vi.fn(),
  }),
}));

const {
  MAX_LONG_FORM,
  countLongFormCandidates,
  generateLongFormCaptions,
  generateLongFormForArticle,
  selectLongFormCandidates,
  WORST_ATTEMPT_MS,
} = await import("./long-form");

const assessment = (over: Partial<ArticleAssessment> = {}): ArticleAssessment => ({
  relevant: true,
  relevanceScore: 0.9,
  interestScore: 0.8,
  summary: "สรุปใหม่",
  caption: "แคปชันยาวที่เขียนจากเนื้อข่าวจริง",
  hashtags: ["#ใหม่"],
  ...over,
});

let userId: number;
let otherUserId: number;
let topicId: number;
let seq = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  mockFetchContent.mockResolvedValue({ ok: true, text: "เนื้อข่าวเต็มจากเว็บจริง" });
  mockResolve.mockResolvedValue({ ok: true, url: "https://publisher.example/a" });
  mockProcessArticle.mockResolvedValue(assessment());

  await db.delete(users);
  const [u] = await db
    .insert(users)
    .values({ username: "owner", passwordHash: hashPassword("x-pass-8"), status: "active" })
    .returning();
  const [o] = await db
    .insert(users)
    .values({ username: "other", passwordHash: hashPassword("x-pass-8"), status: "active" })
    .returning();
  userId = u.id;
  otherUserId = o.id;
  const [t] = await db.insert(topics).values({ userId, name: "หัวข้อ", keywords: ["k"] }).returning();
  topicId = t.id;
});

async function seed(over: {
  status?: ArticleStatus;
  interestScore?: number | null;
  content?: string | null;
  tId?: number;
  url?: string;
} = {}) {
  seq++;
  const [a] = await db
    .insert(articles)
    .values({
      topicId: over.tId ?? topicId,
      title: `ข่าว ${seq}`,
      url: over.url ?? `https://news.google.com/articles/${seq}`,
      status: over.status ?? "draft",
      interestScore: over.interestScore === undefined ? 0.5 : over.interestScore,
      content: over.content ?? null,
      caption: "แคปชันสั้นเดิม",
    })
    .returning();
  return a;
}

describe("selectLongFormCandidates", () => {
  it("เรียงตามคะแนนความน่าสนใจจากมากไปน้อย", async () => {
    const low = await seed({ interestScore: 0.2 });
    const high = await seed({ interestScore: 0.95 });
    const mid = await seed({ interestScore: 0.6 });

    const got = await selectLongFormCandidates({ userId, limit: 10 });

    expect(got.map((c) => c.id)).toEqual([high.id, mid.id, low.id]);
  });

  it("เอาเฉพาะข่าวสถานะ draft — ไม่แตะที่อนุมัติ/โพส/ปฏิเสธแล้ว", async () => {
    const draft = await seed({ status: "draft" });
    // รวม draft_long ด้วย — ข่าวที่เขียนยาวไปแล้วต้องไม่ถูกเลือกซ้ำในรอบถัดไป
    for (const s of [
      "approved",
      "posted",
      "rejected",
      "irrelevant",
      "fetched",
      "draft_long",
    ] as ArticleStatus[]) {
      await seed({ status: s });
    }
    const got = await selectLongFormCandidates({ userId, limit: 10 });
    expect(got.map((c) => c.id)).toEqual([draft.id]);
  });

  it("ข้ามข่าวที่เคยเขียนยาวไปแล้ว (มี content แล้ว)", async () => {
    await seed({ content: "เคยดึงมาแล้ว" });
    const fresh = await seed();
    const got = await selectLongFormCandidates({ userId, limit: 10 });
    expect(got.map((c) => c.id)).toEqual([fresh.id]);
  });

  /**
   * เว็บที่บล็อกบอท/404 มักเป็นข่าวเด่นคะแนนสูง ถ้าเรียงตามคะแนนล้วน
   * มันจะลอยขึ้นหัวคิวมาขวางทุกครั้งที่กดปุ่ม จนข่าวอื่นไม่มีวันได้คิว
   */
  it("ตัวที่เคยพังลงท้ายแถว แม้คะแนนจะสูงกว่า", async () => {
    const failedHigh = await seed({ interestScore: 0.99 });
    const freshLow = await seed({ interestScore: 0.1 });
    await db
      .update(articles)
      .set({ longFormFailedAt: new Date() })
      .where(eq(articles.id, failedHigh.id));

    const got = await selectLongFormCandidates({ userId, limit: 10 });

    expect(got.map((c) => c.id)).toEqual([freshLow.id, failedHigh.id]);
  });

  it("ในกลุ่มที่เคยพังด้วยกัน ตัวที่พังนานแล้วได้ลองก่อน (เว็บอาจกลับมาแล้ว)", async () => {
    const old = await seed({ interestScore: 0.1 });
    const recent = await seed({ interestScore: 0.9 });
    await db
      .update(articles)
      .set({ longFormFailedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(articles.id, old.id));
    await db
      .update(articles)
      .set({ longFormFailedAt: new Date() })
      .where(eq(articles.id, recent.id));

    const got = await selectLongFormCandidates({ userId, limit: 10 });

    expect(got.map((c) => c.id)).toEqual([old.id, recent.id]);
  });

  it("ข่าวที่ยังไม่มีคะแนน (ข้อมูลเก่า) อยู่ท้ายแถวแต่ยังเลือกได้", async () => {
    const scored = await seed({ interestScore: 0.3 });
    const unscored = await seed({ interestScore: null });
    const got = await selectLongFormCandidates({ userId, limit: 10 });
    expect(got.map((c) => c.id)).toEqual([scored.id, unscored.id]);
  });

  it("ไม่เห็นข่าวของผู้ใช้อื่น", async () => {
    const [t2] = await db
      .insert(topics)
      .values({ userId: otherUserId, name: "ของคนอื่น", keywords: ["x"] })
      .returning();
    await seed({ tId: t2.id, interestScore: 0.99 });
    const mine = await seed({ interestScore: 0.1 });

    const got = await selectLongFormCandidates({ userId, limit: 10 });
    expect(got.map((c) => c.id)).toEqual([mine.id]);
  });
});

describe("generateLongFormCaptions", () => {
  it("เขียนแคปชันยาวและบันทึกลงข่าว พร้อมเก็บเนื้อข่าวไว้", async () => {
    const a = await seed();
    const res = await generateLongFormCaptions({ userId, limit: 1 });

    expect(res.generated).toBe(1);
    const after = await db.query.articles.findFirst({ where: eq(articles.id, a.id) });
    expect(after?.caption).toBe("แคปชันยาวที่เขียนจากเนื้อข่าวจริง");
    expect(after?.content).toBe("เนื้อข่าวเต็มจากเว็บจริง");
    // แยกออกจากร่างปกติ ผู้ใช้จะได้เห็นด้วยตาว่าชิ้นไหนผ่านการอ่านเว็บจริงมาแล้ว
    expect(after?.status).toBe("draft_long");
  });

  it("ร่างยาวรอบสองยังคงเป็นร่างยาว (ไม่เด้งกลับเป็นร่างปกติ)", async () => {
    const a = await seed({ status: "draft_long", content: "เคยดึงแล้ว" });
    await generateLongFormForArticle({ userId, articleId: a.id });
    expect((await db.query.articles.findFirst({ where: eq(articles.id, a.id) }))?.status).toBe(
      "draft_long",
    );
  });

  it("สั่งเขียนยาวให้ข่าวที่อนุมัติแล้ว ต้องไม่ถอนการอนุมัติของคนทิ้ง", async () => {
    const a = await seed({ status: "approved" });
    expect(await generateLongFormForArticle({ userId, articleId: a.id })).toEqual({ ok: true });
    const after = await db.query.articles.findFirst({ where: eq(articles.id, a.id) });
    expect(after?.status).toBe("approved");
    expect(after?.caption).toBe("แคปชันยาวที่เขียนจากเนื้อข่าวจริง");
  });

  // content คือตัวสั่งโหมดเขียนยาวในตัวมันเอง (ดู captionInstruction ใน ai/gemini.ts)
  // ไม่มีสวิตช์แยกอีกแล้ว — ขอความยาวเกินกว่าวัตถุดิบที่มีจริงจึงเป็นไปไม่ได้
  it("ส่งเนื้อข่าวจริงให้ AI (= สั่งโหมดเขียนยาวในตัว)", async () => {
    await seed();
    await generateLongFormCaptions({ userId, limit: 1 });

    expect(mockProcessArticle).toHaveBeenCalledWith(
      expect.objectContaining({ content: "เนื้อข่าวเต็มจากเว็บจริง" }),
    );
  });

  it("ดึงเนื้อไม่ได้ = ข้ามไปข่าวถัดไปจนได้ครบตามจำนวน", async () => {
    for (let i = 0; i < 4; i++) await seed();
    // สองตัวแรกดึงไม่ได้ ตัวที่สามขึ้นไปได้
    mockFetchContent
      .mockResolvedValueOnce({ ok: false, reason: "เว็บตอบกลับ HTTP 403" })
      .mockResolvedValueOnce({ ok: false, reason: "paywall" })
      .mockResolvedValue({ ok: true, text: "เนื้อข่าวเต็มจากเว็บจริง" });

    const res = await generateLongFormCaptions({ userId, limit: 2 });

    expect(res.generated).toBe(2);
    expect(res.skipped).toBe(2);
    expect(res.outcomes.filter((o) => !o.ok).map((o) => o.reason)).toEqual([
      "เว็บตอบกลับ HTTP 403",
      "paywall",
    ]);
  });

  it("ดึงไม่ได้ทุกตัว = generated 0 แต่ไม่ throw และรายงานเหตุผลครบ", async () => {
    for (let i = 0; i < 3; i++) await seed();
    mockFetchContent.mockResolvedValue({ ok: false, reason: "บล็อกบอท" });

    const res = await generateLongFormCaptions({ userId, limit: 5 });

    expect(res.generated).toBe(0);
    expect(res.skipped).toBe(3);
    expect(res.outcomes.every((o) => o.reason === "บล็อกบอท")).toBe(true);
  });

  it("แกะลิงก์จริงไม่สำเร็จ = ข้ามข่าวนั้น ไม่ยิงเว็บต่อ", async () => {
    await seed();
    mockResolve.mockResolvedValue({ ok: false, reason: "ไม่พบลายเซ็น" });

    const res = await generateLongFormCaptions({ userId, limit: 1 });

    expect(res.generated).toBe(0);
    expect(mockFetchContent).not.toHaveBeenCalled();
  });

  it("AI พัง = ข้ามข่าวนั้น ไม่ล้มทั้งรอบ", async () => {
    await seed();
    await seed();
    mockProcessArticle
      .mockRejectedValueOnce(new Error("400 INVALID_ARGUMENT"))
      .mockResolvedValue(assessment());

    const res = await generateLongFormCaptions({ userId, limit: 1 });

    expect(res.generated).toBe(1);
    expect(res.outcomes[0]).toMatchObject({ ok: false });
  });

  it("AI อ่านเนื้อเต็มแล้วบอกว่าไม่เกี่ยวข้อง = ข้าม พร้อมเหตุผลที่ไม่ทำให้เข้าใจผิดว่าระบบพัง", async () => {
    const a = await seed();
    mockProcessArticle.mockResolvedValue(assessment({ relevant: false, caption: null }));

    const res = await generateLongFormCaptions({ userId, limit: 1 });

    expect(res.generated).toBe(0);
    expect(res.outcomes[0].reason).toContain("ไม่เกี่ยวข้อง");
    const after = await db.query.articles.findFirst({ where: eq(articles.id, a.id) });
    expect(after?.caption).toBe("แคปชันสั้นเดิม");
  });

  it("AI ไม่คืนแคปชัน = ถือว่าข้าม ไม่บันทึกค่าว่างทับของเดิม", async () => {
    const a = await seed();
    mockProcessArticle.mockResolvedValue(assessment({ caption: null }));

    const res = await generateLongFormCaptions({ userId, limit: 1 });

    expect(res.generated).toBe(0);
    const after = await db.query.articles.findFirst({ where: eq(articles.id, a.id) });
    expect(after?.caption).toBe("แคปชันสั้นเดิม");
    expect(after?.content).toBeNull();
  });

  it("บีบ limit ไม่ให้เกินเพดาน", async () => {
    for (let i = 0; i < 8; i++) await seed();
    const res = await generateLongFormCaptions({ userId, limit: 99 });
    expect(res.generated).toBe(MAX_LONG_FORM);
    expect(MAX_LONG_FORM).toBe(5);
  });

  it("ไม่มีข่าวเข้าเกณฑ์ = 0 ไม่ error", async () => {
    const res = await generateLongFormCaptions({ userId, limit: 5 });
    expect(res).toMatchObject({ generated: 0, skipped: 0 });
  });

  /**
   * หน้าเว็บยิงทีละชิ้นหลายรอบเพื่อกัน timeout — แต่ละรอบเป็นคำขออิสระ
   * ถ้าไม่บอกว่าตัวไหนพังไปแล้ว มันจะหยิบตัวคะแนนสูงสุดตัวเดิมมาลองซ้ำทุกรอบ
   */
  it("พังแล้วต้องติดเครื่องหมายไว้ — กดใหม่พรุ่งนี้จะได้ไม่มาขวางหัวคิวอีก", async () => {
    const a = await seed();
    mockFetchContent.mockResolvedValue({ ok: false, reason: "เว็บตอบกลับ HTTP 404" });

    await generateLongFormCaptions({ userId, limit: 1 });

    const after = await db.query.articles.findFirst({ where: eq(articles.id, a.id) });
    expect(after?.longFormFailedAt).toBeInstanceOf(Date);
  });

  it("สำเร็จแล้วต้องล้างเครื่องหมายทิ้ง (เว็บกลับมาใช้ได้แล้ว ไม่ควรถูกลงโทษต่อ)", async () => {
    const a = await seed();
    await db
      .update(articles)
      .set({ longFormFailedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(articles.id, a.id));

    await generateLongFormCaptions({ userId, limit: 1 });

    const after = await db.query.articles.findFirst({ where: eq(articles.id, a.id) });
    expect(after?.longFormFailedAt).toBeNull();
  });

  it("excludeIds = ข้ามข่าวที่รอบก่อนลองแล้วพัง ไม่วนลองตัวเดิม", async () => {
    const failed = await seed({ interestScore: 0.9 });
    const next = await seed({ interestScore: 0.8 });

    const res = await generateLongFormCaptions({ userId, limit: 1, excludeIds: [failed.id] });

    expect(res.generated).toBe(1);
    expect(res.outcomes[0].articleId).toBe(next.id);
  });

  it("หมดงบเวลา = หยุดก่อน คืนผลบางส่วนพร้อมบอกว่าให้กดต่อ (ไม่ปล่อยให้ถูกตัดทิ้ง)", async () => {
    await seed();
    await seed();

    // budgetMs 0 = เลยงบตั้งแต่ชิ้นแรก จึงไม่ควรเรียก AI เลยสักครั้ง
    const res = await generateLongFormCaptions({ userId, limit: 5, budgetMs: 0 });

    expect(res.generated).toBe(0);
    expect(mockProcessArticle).not.toHaveBeenCalled();
    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0]).toMatchObject({ ok: false, outOfTime: true });
    expect(res.outcomes[0].reason).toContain("กดอีกครั้ง");
  });

  /**
   * นี่คือรูปแบบที่ทำให้เกิด FUNCTION_INVOCATION_TIMEOUT รอบล่าสุด:
   * เดิมเช็คแค่ "ยังไม่หมดงบ" จึงเริ่มชิ้นใหม่ตอนใกล้หมดเวลาได้ แล้วชิ้นนั้นลากยาวจนทะลุ
   * ตอนนี้ต้องเหลือเวลาพอสำหรับกรณีแย่ที่สุดของทั้งชิ้น ถึงจะเริ่มได้
   */
  it("เหลือเวลาไม่พอสำหรับอีกหนึ่งชิ้นเต็ม ๆ = ไม่เริ่มชิ้นใหม่", async () => {
    await seed();
    await seed();
    // ชิ้นแรกกินเวลาจริง 500ms พอให้เวลาที่เหลือน้อยกว่างบกรณีแย่สุด
    mockFetchContent.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ ok: true, text: "เนื้อข่าวเต็มจากเว็บจริง" }), 500),
        ),
    );

    const res = await generateLongFormCaptions({
      userId,
      limit: 5,
      // เผื่อไว้ 300ms สำหรับ query หาผู้สมัคร — พอให้ชิ้นแรกได้เริ่ม แต่ชิ้นที่สองไม่ได้
      budgetMs: WORST_ATTEMPT_MS + 300,
    });

    expect(res.generated).toBe(1);
    expect(res.outcomes.at(-1)).toMatchObject({ ok: false, outOfTime: true });
  });

  it("งบเวลาเหลือเฟือ = ทำครบตามที่ขอ ไม่หยุดกลางคัน", async () => {
    for (let i = 0; i < 3; i++) await seed();
    const res = await generateLongFormCaptions({ userId, limit: 3, budgetMs: 60_000 });
    expect(res.generated).toBe(3);
    expect(res.outcomes.every((o) => !o.outOfTime)).toBe(true);
  });

  it("ใช้ resolvedUrl ที่ cache ไว้แล้ว ไม่แกะซ้ำ", async () => {
    const a = await seed();
    await db
      .update(articles)
      .set({ resolvedUrl: "https://publisher.example/cached" })
      .where(eq(articles.id, a.id));

    await generateLongFormCaptions({ userId, limit: 1 });

    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockFetchContent).toHaveBeenCalledWith("https://publisher.example/cached");
  });
});

describe("generateLongFormForArticle", () => {
  it("สั่งรายข่าวได้", async () => {
    const a = await seed();
    expect(await generateLongFormForArticle({ userId, articleId: a.id })).toEqual({ ok: true });
  });

  it("ข่าวของคนอื่น = 404", async () => {
    const [t2] = await db
      .insert(topics)
      .values({ userId: otherUserId, name: "ของคนอื่น", keywords: ["x"] })
      .returning();
    const a = await seed({ tId: t2.id });
    expect(await generateLongFormForArticle({ userId, articleId: a.id })).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it("สั่งซ้ำข่าวที่เคยเขียนยาวแล้วได้ (ปุ่มรายข่าวไม่ติดเงื่อนไข content)", async () => {
    const a = await seed({ content: "เคยดึงแล้ว" });
    expect(await generateLongFormForArticle({ userId, articleId: a.id })).toEqual({ ok: true });
  });

  it("ดึงเนื้อไม่ได้ = 502 พร้อมเหตุผลที่ผู้ใช้อ่านรู้เรื่อง", async () => {
    const a = await seed();
    mockFetchContent.mockResolvedValue({ ok: false, reason: "หมดเวลาเชื่อมต่อ" });
    expect(await generateLongFormForArticle({ userId, articleId: a.id })).toMatchObject({
      ok: false,
      status: 502,
      error: "หมดเวลาเชื่อมต่อ",
    });
  });
});

describe("countLongFormCandidates", () => {
  it("นับเฉพาะ draft ที่ยังไม่เคยเขียนยาว", async () => {
    await seed();
    await seed();
    await seed({ content: "ทำแล้ว" });
    await seed({ status: "posted" });
    expect(await countLongFormCandidates({ userId })).toBe(2);
  });
});
