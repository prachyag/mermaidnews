import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { articles, topics, users } from "@/db/schema";
import { countArticlesByStatus } from "@/lib/article-counts";
import { STATUS_ORDER } from "@/lib/article-status";

let userId: number;
let otherUserId: number;
let topicId: number;
let otherTopicId: number;

async function seed(over: Partial<typeof articles.$inferInsert> = {}) {
  await db.insert(articles).values({
    topicId,
    title: `ข่าว ${crypto.randomUUID()}`,
    url: `https://example.com/${crypto.randomUUID()}`,
    status: "fetched",
    ...over,
  });
}

beforeEach(async () => {
  await db.delete(articles);
  await db.delete(topics);
  await db.delete(users);

  const [u] = await db
    .insert(users)
    .values({ username: `u-${crypto.randomUUID()}`, passwordHash: "x" })
    .returning();
  userId = u.id;
  const [o] = await db
    .insert(users)
    .values({ username: `o-${crypto.randomUUID()}`, passwordHash: "x" })
    .returning();
  otherUserId = o.id;

  const [t] = await db
    .insert(topics)
    .values({ userId, name: "นางเงือก", keywords: ["นางเงือก"] })
    .returning();
  topicId = t.id;
  const [t2] = await db
    .insert(topics)
    .values({ userId: otherUserId, name: "ของคนอื่น", keywords: ["x"] })
    .returning();
  otherTopicId = t2.id;
});

describe("countArticlesByStatus", () => {
  it("นับแยกตามสถานะ และรวมยอด all ถูกต้อง", async () => {
    await seed({ status: "draft" });
    await seed({ status: "draft" });
    await seed({ status: "posted" });
    await seed({ status: "irrelevant" });

    const counts = await countArticlesByStatus({ userId });

    expect(counts.draft).toBe(2);
    expect(counts.posted).toBe(1);
    expect(counts.irrelevant).toBe(1);
    expect(counts.all).toBe(4);
  });

  it("สถานะที่ไม่มีข่าวต้องเป็น 0 ไม่ใช่ undefined (กันแท็บขึ้น NaN)", async () => {
    await seed({ status: "draft" });

    const counts = await countArticlesByStatus({ userId });

    for (const s of STATUS_ORDER) {
      expect(typeof counts[s]).toBe("number");
    }
    expect(counts.posted).toBe(0);
    expect(counts.failed).toBe(0);
  });

  it("ไม่มีข่าวเลย -> ทุกช่องเป็น 0", async () => {
    const counts = await countArticlesByStatus({ userId });

    expect(counts.all).toBe(0);
    for (const s of STATUS_ORDER) expect(counts[s]).toBe(0);
  });

  it("ไม่นับข่าวของบัญชีอื่น", async () => {
    await seed({ status: "draft" });
    await db.insert(articles).values({
      topicId: otherTopicId,
      title: "ของคนอื่น",
      url: "https://example.com/theirs",
      status: "draft",
    });

    const counts = await countArticlesByStatus({ userId });

    expect(counts.draft).toBe(1);
    expect(counts.all).toBe(1);
  });

  it("ระบุ topicId -> นับเฉพาะหัวข้อนั้น", async () => {
    const [t2] = await db
      .insert(topics)
      .values({ userId, name: "หัวข้อสอง", keywords: ["k"] })
      .returning();
    await seed({ status: "draft" });
    await db.insert(articles).values({
      topicId: t2.id,
      title: "อีกหัวข้อ",
      url: "https://example.com/t2",
      status: "draft",
    });

    expect((await countArticlesByStatus({ userId, topicId })).all).toBe(1);
    expect((await countArticlesByStatus({ userId, topicId: t2.id })).all).toBe(1);
    expect((await countArticlesByStatus({ userId, topicId: "all" })).all).toBe(2);
  });
});
