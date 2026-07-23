import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiCallLogs, topics, users, type AiCallLog, type UserRole } from "@/db/schema";
import { hashPassword } from "./password";
import {
  assessHealth,
  buildAiCallValues,
  listRecentAiCalls,
  pruneAiCallLogs,
  recordAiCall,
  summarize,
  summarizeAiCalls,
} from "./ai-stats";

/** สร้างแถวสถิติปลอมสำหรับทดสอบ summarize (ไม่แตะ DB) */
function row(over: Partial<AiCallLog> = {}): AiCallLog {
  return {
    id: 1,
    topicId: 1,
    topicName: "นางเงือก",
    model: "gemini-flash-latest",
    mode: "batch",
    requested: 5,
    returned: 5,
    durationMs: 4000,
    ok: true,
    errorMessage: null,
    createdAt: new Date("2026-07-23T10:00:00Z"),
    ...over,
  };
}

describe("buildAiCallValues", () => {
  it("บีบค่าที่เป็นไปไม่ได้: returned มากกว่า requested", () => {
    const v = buildAiCallValues({
      topicId: 1, topicName: "t", model: "m", mode: "batch",
      requested: 5, returned: 9, durationMs: 100, ok: true,
    });
    expect(v.returned).toBe(5);
  });

  it("บีบค่าติดลบให้เป็น 0", () => {
    const v = buildAiCallValues({
      topicId: 1, topicName: "t", model: "m", mode: "batch",
      requested: 5, returned: -3, durationMs: -50, ok: true,
    });
    expect(v.returned).toBe(0);
    expect(v.durationMs).toBe(0);
  });

  it("errorMessage ที่ไม่ได้ส่งมา = null", () => {
    const v = buildAiCallValues({
      topicId: null, topicName: "t", model: "m", mode: "single",
      requested: 1, returned: 1, durationMs: 10, ok: true,
    });
    expect(v.errorMessage).toBeNull();
  });
});

describe("assessHealth — จับการเสื่อมก่อนพังสนิท", () => {
  const healthy = { totalCalls: 10, successRate: 1, completeness: 1, avgMsPerArticle: 800 };

  it("ปกติทุกอย่าง = ok", () => {
    expect(assessHealth(healthy)).toEqual({ health: "ok", reasons: [] });
  });

  it("ยังไม่เคยเรียก = unknown (ไม่ใช่ ok — ยังไม่มีข้อมูลยืนยัน)", () => {
    expect(assessHealth({ ...healthy, totalCalls: 0 }).health).toBe("unknown");
  });

  it("ล้มเหลวทุกครั้ง = down (แบบเหตุการณ์ 23 ก.ค.)", () => {
    const r = assessHealth({ ...healthy, successRate: 0 });
    expect(r.health).toBe("down");
    expect(r.reasons[0]).toContain("ล้มเหลวทุกครั้ง");
  });

  it("สำเร็จทุกครั้งแต่ตอบไม่ครบ = degraded (อาการที่ไม่ throw error จึงมองไม่เห็น)", () => {
    const r = assessHealth({ ...healthy, completeness: 0.3 });
    expect(r.health).toBe("degraded");
    expect(r.reasons.join(" ")).toContain("ไม่ครบ");
  });

  it("อัตราสำเร็จตก = degraded", () => {
    expect(assessHealth({ ...healthy, successRate: 0.5 }).health).toBe("degraded");
  });

  it("ช้าผิดปกติ = degraded (เคสจริงพุ่งจาก 4 เป็น 30 วินาที)", () => {
    const r = assessHealth({ ...healthy, avgMsPerArticle: 6000 });
    expect(r.health).toBe("degraded");
    expect(r.reasons.join(" ")).toContain("ช้าผิดปกติ");
  });

  it("เสื่อมหลายอย่างพร้อมกัน = รายงานครบทุกเหตุผล", () => {
    const r = assessHealth({ totalCalls: 5, successRate: 0.5, completeness: 0.4, avgMsPerArticle: 9000 });
    expect(r.health).toBe("degraded");
    expect(r.reasons).toHaveLength(3);
  });

  it("ครบ 90% พอดี ยังถือว่า ok (ไม่ตื่นตูมเกินจำเป็น)", () => {
    expect(assessHealth({ ...healthy, completeness: 0.9, successRate: 0.9 }).health).toBe("ok");
  });
});

describe("summarize", () => {
  it("คำนวณอัตราสำเร็จและความครบถูกต้อง", () => {
    const s = summarize([
      row({ id: 1, requested: 10, returned: 10, ok: true, durationMs: 4000 }),
      row({ id: 2, requested: 10, returned: 2, ok: true, durationMs: 30000 }),
    ]);
    expect(s.totalCalls).toBe(2);
    expect(s.successRate).toBe(1);
    expect(s.requested).toBe(20);
    expect(s.returned).toBe(12);
    expect(s.completeness).toBeCloseTo(0.6);
    expect(s.health).toBe("degraded"); // สำเร็จหมดแต่ได้ข่าวไม่ครบ
  });

  it("เวลาเฉลี่ยต่อข่าวเทียบข้ามขนาดชุดได้", () => {
    const s = summarize([
      row({ id: 1, requested: 10, returned: 10, durationMs: 10000 }),
      row({ id: 2, requested: 1, returned: 1, durationMs: 1000 }),
    ]);
    expect(s.avgMsPerArticle).toBe(1000); // 11000ms / 11 ข่าว
    expect(s.avgDurationMs).toBe(5500);
  });

  it("ไม่มีข้อมูล = unknown และไม่หารด้วยศูนย์", () => {
    const s = summarize([]);
    expect(s.health).toBe("unknown");
    expect(s.avgMsPerArticle).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.lastCallAt).toBeNull();
  });

  it("คืน error ล่าสุดของรายการที่ล้มเหลว", () => {
    const s = summarize([
      row({ id: 2, ok: false, errorMessage: "400 INVALID_ARGUMENT", returned: 0 }),
      row({ id: 1, ok: true }),
    ]);
    expect(s.lastError).toBe("400 INVALID_ARGUMENT");
    expect(s.failedCalls).toBe(1);
  });
});

// ── ส่วนที่แตะฐานข้อมูลจริง ─────────────────────────────────────────
async function makeUser(username: string, role: UserRole = "user") {
  const [u] = await db
    .insert(users)
    .values({ username, role, status: "active", passwordHash: hashPassword("x-password-8") })
    .returning();
  return u;
}

async function makeTopic(userId: number, name: string) {
  const [t] = await db.insert(topics).values({ userId, name, keywords: ["k"] }).returning();
  return t;
}

describe("recordAiCall / ขอบเขตสิทธิ์ / การหมุนเวียน", () => {
  beforeEach(async () => {
    await db.delete(aiCallLogs);
    await db.delete(users);
  });

  it("บันทึกแล้วอ่านกลับได้", async () => {
    const u = await makeUser("owner");
    const t = await makeTopic(u.id, "นางเงือก");
    await recordAiCall({
      topicId: t.id, topicName: t.name, model: "gemini-flash-latest", mode: "batch",
      requested: 5, returned: 3, durationMs: 4200, ok: true,
    });
    const list = await listRecentAiCalls(u.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ requested: 5, returned: 3, ok: true, mode: "batch" });
  });

  it("ไม่ throw แม้บันทึกไม่สำเร็จ — งานหลักต้องไม่พังเพราะเก็บสถิติ", async () => {
    // topicId ที่ไม่มีจริง → ชน foreign key
    await expect(
      recordAiCall({
        topicId: 999999, topicName: "ผี", model: "m", mode: "batch",
        requested: 1, returned: 1, durationMs: 1, ok: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("ผู้ใช้ทั่วไปเห็นเฉพาะสถิติของหัวข้อตัวเอง", async () => {
    const me = await makeUser("me");
    const other = await makeUser("other");
    const mine = await makeTopic(me.id, "ของฉัน");
    const theirs = await makeTopic(other.id, "ของคนอื่น");
    const base = { model: "m", mode: "batch" as const, requested: 1, returned: 1, durationMs: 10, ok: true };
    await recordAiCall({ ...base, topicId: mine.id, topicName: mine.name });
    await recordAiCall({ ...base, topicId: theirs.id, topicName: theirs.name });

    const list = await listRecentAiCalls(me.id);
    expect(list.map((r) => r.topicName)).toEqual(["ของฉัน"]);
  });

  it("admin เห็นสถิติทั้งระบบ (เป็นเรื่องสุขภาพระบบ ไม่ใช่ข้อมูลส่วนตัว)", async () => {
    const admin = await makeUser("admin", "admin");
    const other = await makeUser("other");
    const theirs = await makeTopic(other.id, "ของคนอื่น");
    await recordAiCall({
      topicId: theirs.id, topicName: theirs.name, model: "m", mode: "batch",
      requested: 1, returned: 1, durationMs: 10, ok: true,
    });
    expect(await listRecentAiCalls(admin.id)).toHaveLength(1);
  });

  it("ผู้ใช้ที่ยังไม่มีหัวข้อ ไม่เห็นสถิติของใครเลย", async () => {
    const me = await makeUser("me");
    const other = await makeUser("other");
    const theirs = await makeTopic(other.id, "ของคนอื่น");
    await recordAiCall({
      topicId: theirs.id, topicName: theirs.name, model: "m", mode: "batch",
      requested: 1, returned: 1, durationMs: 10, ok: true,
    });
    expect(await listRecentAiCalls(me.id)).toHaveLength(0);
    expect((await summarizeAiCalls(me.id)).totalCalls).toBe(0);
  });

  it("นับเฉพาะช่วงเวลาที่ขอ (sinceHours)", async () => {
    const u = await makeUser("owner");
    const t = await makeTopic(u.id, "หัวข้อ");
    const base = buildAiCallValues({
      topicId: t.id, topicName: t.name, model: "m", mode: "batch",
      requested: 1, returned: 1, durationMs: 10, ok: true,
    });
    await db.insert(aiCallLogs).values({ ...base, createdAt: new Date(Date.now() - 48 * 3600_000) });
    await db.insert(aiCallLogs).values({ ...base, createdAt: new Date() });

    expect((await summarizeAiCalls(u.id, { sinceHours: 24 })).totalCalls).toBe(1);
    expect((await summarizeAiCalls(u.id, { sinceHours: 72 })).totalCalls).toBe(2);
  });

  it("สรุปสุขภาพจากข้อมูลจริงใน DB ได้", async () => {
    const u = await makeUser("owner");
    const t = await makeTopic(u.id, "หัวข้อ");
    const base = { topicId: t.id, topicName: t.name, model: "m", mode: "batch" as const };
    await recordAiCall({ ...base, requested: 10, returned: 1, durationMs: 30000, ok: true });
    const s = await summarizeAiCalls(u.id);
    expect(s.health).toBe("degraded");
    expect(s.completeness).toBeCloseTo(0.1);
  });

  it("หมุนเวียนของเก่าทิ้งเมื่อเกินเพดาน", async () => {
    const u = await makeUser("owner");
    const t = await makeTopic(u.id, "หัวข้อ");
    const base = buildAiCallValues({
      topicId: t.id, topicName: t.name, model: "m", mode: "batch",
      requested: 1, returned: 1, durationMs: 10, ok: true,
    });
    for (let i = 0; i < 8; i++) {
      await db.insert(aiCallLogs).values({ ...base, createdAt: new Date(2026, 0, 1, 0, i) });
    }
    await pruneAiCallLogs(3);
    const rows = await db.select().from(aiCallLogs).orderBy(aiCallLogs.createdAt);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.createdAt.getMinutes())).toEqual([5, 6, 7]); // เก็บใหม่สุด
  });

  it("สถิติอยู่ต่อแม้หัวข้อถูกลบ (topicId เป็น null แต่ชื่อยังอ่านได้)", async () => {
    const admin = await makeUser("admin", "admin");
    const t = await makeTopic(admin.id, "หัวข้อที่จะถูกลบ");
    await recordAiCall({
      topicId: t.id, topicName: t.name, model: "m", mode: "batch",
      requested: 1, returned: 1, durationMs: 10, ok: true,
    });
    await db.delete(topics).where(eq(topics.id, t.id));
    const rows = await db.select().from(aiCallLogs);
    expect(rows).toHaveLength(1);
    expect(rows[0].topicId).toBeNull();
    expect(rows[0].topicName).toBe("หัวข้อที่จะถูกลบ");
  });
});
