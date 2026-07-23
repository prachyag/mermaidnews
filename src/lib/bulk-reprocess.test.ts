import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, topics, users, type ArticleStatus } from "@/db/schema";
import { hashPassword } from "./password";
import { isReprocessable, MAX_REPROCESS, REPROCESSABLE, reprocessArticles } from "./bulk-reprocess";

let userId: number;
let otherUserId: number;
let topicId: number;
let otherTopicId: number;
let foreignTopicId: number;

beforeEach(async () => {
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
  const [t] = await db.insert(topics).values({ userId, name: "หัวข้อ A", keywords: ["a"] }).returning();
  const [t2] = await db.insert(topics).values({ userId, name: "หัวข้อ B", keywords: ["b"] }).returning();
  const [t3] = await db
    .insert(topics)
    .values({ userId: otherUserId, name: "ของคนอื่น", keywords: ["c"] })
    .returning();
  topicId = t.id;
  otherTopicId = t2.id;
  foreignTopicId = t3.id;
});

let seq = 0;
async function seed(status: ArticleStatus, tId = topicId) {
  seq++;
  const [a] = await db
    .insert(articles)
    .values({
      topicId: tId,
      title: `ข่าว ${seq}`,
      url: `https://example.com/${seq}`,
      status,
      caption: "แคปชันเดิม",
      summary: "สรุปเดิม",
      hashtags: ["#เดิม"],
      relevanceScore: 0.8,
    })
    .returning();
  return a;
}

async function statusOf(id: number) {
  const a = await db.query.articles.findFirst({ where: eq(articles.id, id) });
  return a?.status;
}

describe("REPROCESSABLE / isReprocessable", () => {
  it("อนุญาตเฉพาะผลที่ AI สร้างเอง", () => {
    expect(REPROCESSABLE).toEqual(["draft", "irrelevant"]);
  });

  it.each(["draft", "irrelevant"])("รับ %s", (s) => {
    expect(isReprocessable(s)).toBe(true);
  });

  it.each(["approved", "scheduled", "posted", "rejected", "failed", "fetched", "", null, 1])(
    "ปฏิเสธ %s (ผ่านการตัดสินใจของคนแล้ว หรือไม่ต้องทำซ้ำ)",
    (s) => {
      expect(isReprocessable(s)).toBe(false);
    },
  );
});

describe("reprocessArticles", () => {
  it("ตั้ง draft/irrelevant กลับเป็น fetched", async () => {
    const a = await seed("draft");
    const b = await seed("irrelevant");

    const res = await reprocessArticles({ userId });

    expect(res.queued).toBe(2);
    expect(await statusOf(a.id)).toBe("fetched");
    expect(await statusOf(b.id)).toBe("fetched");
  });

  it("ไม่แตะสถานะที่ผ่านการตัดสินใจของคนแล้ว", async () => {
    const kept: ArticleStatus[] = ["approved", "scheduled", "posted", "rejected", "failed"];
    const ids = await Promise.all(kept.map((s) => seed(s)));

    const res = await reprocessArticles({ userId });

    expect(res.queued).toBe(0);
    for (const [i, a] of ids.entries()) {
      expect(await statusOf(a.id)).toBe(kept[i]);
    }
  });

  it("ไม่ล้างแคปชันเดิมทิ้ง — ถ้า AI ล้มเหลวผู้ใช้ยังมีของเดิมใช้", async () => {
    const a = await seed("draft");
    await reprocessArticles({ userId });
    const after = await db.query.articles.findFirst({ where: eq(articles.id, a.id) });
    expect(after?.caption).toBe("แคปชันเดิม");
    expect(after?.summary).toBe("สรุปเดิม");
  });

  it("ไม่แตะข่าวของผู้ใช้อื่น", async () => {
    const mine = await seed("draft");
    const theirs = await seed("draft", foreignTopicId);

    const res = await reprocessArticles({ userId });

    expect(res.queued).toBe(1);
    expect(await statusOf(mine.id)).toBe("fetched");
    expect(await statusOf(theirs.id)).toBe("draft");
  });

  it("จำกัดเฉพาะหัวข้อที่เลือกได้", async () => {
    const a = await seed("draft", topicId);
    const b = await seed("draft", otherTopicId);

    const res = await reprocessArticles({ userId, topicId });

    expect(res.queued).toBe(1);
    expect(await statusOf(a.id)).toBe("fetched");
    expect(await statusOf(b.id)).toBe("draft");
  });

  it('topicId = "all" ครอบทุกหัวข้อของผู้ใช้', async () => {
    await seed("draft", topicId);
    await seed("draft", otherTopicId);
    expect((await reprocessArticles({ userId, topicId: "all" })).queued).toBe(2);
  });

  it("จำกัดเฉพาะสถานะเดียวได้ (เช่น เอาแต่ irrelevant)", async () => {
    const d = await seed("draft");
    const i = await seed("irrelevant");

    const res = await reprocessArticles({ userId, status: "irrelevant" });

    expect(res.queued).toBe(1);
    expect(await statusOf(d.id)).toBe("draft");
    expect(await statusOf(i.id)).toBe("fetched");
  });

  it("เกินเพดาน = ทำเท่าที่ทำได้ แล้วบอกจำนวนที่เหลือ", async () => {
    for (let i = 0; i < 5; i++) await seed("draft");

    const res = await reprocessArticles({ userId, limit: 2 });

    expect(res.queued).toBe(2);
    expect(res.remaining).toBe(3);
    const still = await db
      .select()
      .from(articles)
      .where(and(eq(articles.topicId, topicId), eq(articles.status, "draft")));
    expect(still).toHaveLength(3);
  });

  it("บีบ limit ไม่ให้เกิน MAX_REPROCESS", async () => {
    for (let i = 0; i < 3; i++) await seed("draft");
    const res = await reprocessArticles({ userId, limit: 99999 });
    expect(res.queued).toBe(3);
    expect(MAX_REPROCESS).toBeLessThanOrEqual(100);
  });

  it("limit ต่ำกว่า 1 ถูกบีบขึ้นเป็น 1 (ไม่กลายเป็นไม่ทำอะไรเงียบ ๆ)", async () => {
    await seed("draft");
    await seed("draft");
    expect((await reprocessArticles({ userId, limit: 0 })).queued).toBe(1);
  });

  it("ไม่มีข่าวเข้าเกณฑ์ = 0 ทั้งคู่ ไม่ error", async () => {
    await seed("posted");
    expect(await reprocessArticles({ userId })).toEqual({ queued: 0, remaining: 0 });
  });

  it("remaining เป็น 0 เมื่อทำครบแล้ว", async () => {
    for (let i = 0; i < 3; i++) await seed("draft");
    expect((await reprocessArticles({ userId, limit: 10 })).remaining).toBe(0);
  });
});
