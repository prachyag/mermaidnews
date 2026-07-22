import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { articles, blockedArticles, topics, users } from "@/db/schema";
import {
  BULK_DELETABLE,
  deleteArticlesByStatus,
  isBulkDeletable,
} from "@/lib/bulk-delete";
import { normalizeTitle } from "@/lib/normalize";

/**
 * เทสของการลบข่าวทีเดียวทั้งหมด
 *
 * สิ่งที่ห้ามพลาด:
 * - ต้องบล็อกทุกชิ้นที่ลบ ไม่งั้นข่าวกลับมาแล้วเผาโควตา AI ซ้ำ (ดู blocked_articles)
 * - ต้องแตะเฉพาะสถานะที่อนุญาต ห้ามกวาด draft/approved/posted ที่ผู้ใช้ลงแรงไปแล้ว
 * - ต้องไม่ข้ามขอบเขตบัญชี
 */

let userId: number;
let otherUserId: number;
let topicId: number;
let otherTopicId: number;

async function seed(over: Partial<typeof articles.$inferInsert> = {}) {
  const [row] = await db
    .insert(articles)
    .values({
      topicId,
      title: `ข่าว ${crypto.randomUUID()}`,
      url: `https://example.com/${crypto.randomUUID()}`,
      status: "irrelevant",
      ...over,
    })
    .returning();
  return row;
}

const exists = async (id: number) =>
  Boolean(await db.query.articles.findFirst({ where: eq(articles.id, id) }));

beforeEach(async () => {
  await db.delete(articles);
  await db.delete(blockedArticles);
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

describe("isBulkDeletable", () => {
  it.each(BULK_DELETABLE)("อนุญาตสถานะ %s", (s) => {
    expect(isBulkDeletable(s)).toBe(true);
  });

  it.each(["draft", "approved", "posted", "scheduled", "fetched", "failed", "", null, 1])(
    "ไม่อนุญาต %j (ของที่ผู้ใช้ลงแรงไปแล้ว ห้ามกวาดยกเข่ง)",
    (s) => {
      expect(isBulkDeletable(s)).toBe(false);
    },
  );
});

describe("deleteArticlesByStatus", () => {
  it("ลบข่าวที่ไม่เกี่ยวข้องทั้งหมด และบล็อกทุกชิ้นที่ลบ", async () => {
    const a1 = await seed({ title: "ไม่เกี่ยว 1" });
    const a2 = await seed({ title: "ไม่เกี่ยว 2" });

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant" });

    expect(result.deleted).toBe(2);
    expect(await exists(a1.id)).toBe(false);
    expect(await exists(a2.id)).toBe(false);

    // ต้องบล็อกไว้ ไม่งั้นรอบดึงถัดไปเก็บกลับมาแล้วเสียโควตา AI ซ้ำ
    const blocked = await db.select().from(blockedArticles);
    expect(blocked).toHaveLength(2);
    expect(blocked.map((b) => b.url).sort()).toEqual([a1.url, a2.url].sort());
    expect(blocked.map((b) => b.titleKey).sort()).toEqual(
      [normalizeTitle("ไม่เกี่ยว 1"), normalizeTitle("ไม่เกี่ยว 2")].sort(),
    );
  });

  it("ไม่แตะข่าวสถานะอื่น", async () => {
    const draft = await seed({ status: "draft" });
    const approved = await seed({ status: "approved" });
    const posted = await seed({ status: "posted" });
    const fetched = await seed({ status: "fetched" });
    const irrelevant = await seed({ status: "irrelevant" });

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant" });

    expect(result.deleted).toBe(1);
    expect(await exists(irrelevant.id)).toBe(false);
    for (const keep of [draft, approved, posted, fetched]) {
      expect(await exists(keep.id)).toBe(true);
    }
    expect(await db.select().from(blockedArticles)).toHaveLength(1);
  });

  it("ลบสถานะ rejected ได้ด้วย", async () => {
    const rejected = await seed({ status: "rejected" });
    const irrelevant = await seed({ status: "irrelevant" });

    const result = await deleteArticlesByStatus({ userId, status: "rejected" });

    expect(result.deleted).toBe(1);
    expect(await exists(rejected.id)).toBe(false);
    expect(await exists(irrelevant.id)).toBe(true);
  });

  it("ไม่แตะข่าวของบัญชีอื่น แม้จะสถานะเดียวกัน", async () => {
    const mine = await seed();
    const [theirs] = await db
      .insert(articles)
      .values({
        topicId: otherTopicId,
        title: "ของคนอื่น",
        url: "https://example.com/theirs",
        status: "irrelevant",
      })
      .returning();

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant" });

    expect(result.deleted).toBe(1);
    expect(await exists(mine.id)).toBe(false);
    expect(await exists(theirs.id)).toBe(true);
    // ต้องไม่ไปบล็อกข่าวในหัวข้อของคนอื่นด้วย
    const blocked = await db.select().from(blockedArticles);
    expect(blocked.every((b) => b.topicId === topicId)).toBe(true);
  });

  it("ระบุ topicId -> ลบเฉพาะหัวข้อนั้น", async () => {
    const [t2] = await db
      .insert(topics)
      .values({ userId, name: "หัวข้อสอง", keywords: ["k"] })
      .returning();
    const inTopic = await seed();
    const [outTopic] = await db
      .insert(articles)
      .values({
        topicId: t2.id,
        title: "อีกหัวข้อ",
        url: "https://example.com/t2",
        status: "irrelevant",
      })
      .returning();

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant", topicId });

    expect(result.deleted).toBe(1);
    expect(await exists(inTopic.id)).toBe(false);
    expect(await exists(outTopic.id)).toBe(true);
  });

  it('topicId "all" -> ลบทุกหัวข้อของบัญชีนี้', async () => {
    const [t2] = await db
      .insert(topics)
      .values({ userId, name: "หัวข้อสอง", keywords: ["k"] })
      .returning();
    const a1 = await seed();
    const [a2] = await db
      .insert(articles)
      .values({
        topicId: t2.id,
        title: "อีกหัวข้อ",
        url: "https://example.com/t2",
        status: "irrelevant",
      })
      .returning();

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant", topicId: "all" });

    expect(result.deleted).toBe(2);
    expect(await exists(a1.id)).toBe(false);
    expect(await exists(a2.id)).toBe(false);
  });

  it("ไม่มีข่าวให้ลบ -> deleted 0 และไม่สร้างรายการบล็อก", async () => {
    await seed({ status: "draft" });

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant" });

    expect(result.deleted).toBe(0);
    expect(await db.select().from(blockedArticles)).toHaveLength(0);
  });

  it("ข่าวที่เคยถูกบล็อกไว้แล้ว ต้องไม่ทำให้ทั้งชุดพัง (onConflictDoNothing)", async () => {
    const a = await seed({ title: "ซ้ำ" });
    // จำลองว่ามีรายการบล็อก url นี้อยู่ก่อนแล้ว (เช่นเคยลบแล้วเลิกบล็อกแล้วโดนดึงกลับมา)
    await db.insert(blockedArticles).values({
      topicId,
      url: a.url,
      titleKey: normalizeTitle("ซ้ำ"),
      title: "ซ้ำ",
    });

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant" });

    expect(result.deleted).toBe(1);
    expect(await exists(a.id)).toBe(false);
    expect(await db.select().from(blockedArticles)).toHaveLength(1);
  });

  it("ลบจำนวนมากได้ (ทดสอบการซอยเป็นก้อน กันชนเพดานพารามิเตอร์ของ SQLite)", async () => {
    for (let i = 0; i < 250; i++) await seed();

    const result = await deleteArticlesByStatus({ userId, status: "irrelevant" });

    expect(result.deleted).toBe(250);
    expect(await db.select().from(articles)).toHaveLength(0);
    expect(await db.select().from(blockedArticles)).toHaveLength(250);
  });
});
