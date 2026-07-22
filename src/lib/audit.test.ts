import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { adminAuditLog, users, type UserRole } from "@/db/schema";
import { hashPassword } from "./password";
import { buildAuditValues, listAuditLog, pruneAuditLog, recordDenied } from "./audit";

async function makeUser(username: string, role: UserRole = "user") {
  const [u] = await db
    .insert(users)
    .values({ username, role, status: "active", passwordHash: hashPassword("x-password-8") })
    .returning();
  return u;
}

describe("buildAuditValues", () => {
  it("เก็บ username เป็น snapshot คู่กับ id (อ่านได้แม้บัญชีถูกลบ)", () => {
    const values = buildAuditValues({
      actor: { id: 1, username: "boss" },
      target: { id: 2, username: "newbie" },
      action: "promote_admin",
      summary: "เลื่อนขั้น",
    });
    expect(values).toEqual({
      actorId: 1,
      actorUsername: "boss",
      targetId: 2,
      targetUsername: "newbie",
      action: "promote_admin",
      outcome: "success",
      summary: "เลื่อนขั้น",
    });
  });

  it("default outcome เป็น success ถ้าไม่ระบุ, และรับ denied ได้", () => {
    expect(
      buildAuditValues({
        actor: { id: 1, username: "a" },
        target: { id: 2, username: "b" },
        action: "set_status",
        summary: "",
        outcome: "denied",
      }).outcome,
    ).toBe("denied");
  });
});

describe("listAuditLog", () => {
  beforeEach(async () => {
    await db.delete(adminAuditLog);
    await db.delete(users);
  });

  it("คนที่ไม่ใช่ admin ดู log ไม่ได้ = null", async () => {
    const member = await makeUser("member");
    expect(await listAuditLog(member.id)).toBeNull();
  });

  it("admin ดูได้ และเรียงใหม่สุดก่อน", async () => {
    const admin = await makeUser("admin", "admin");
    const target = await makeUser("target");
    const base = buildAuditValues({
      actor: admin,
      target,
      action: "set_status",
      summary: "",
    });
    await db.insert(adminAuditLog).values({
      ...base,
      summary: "เก่าสุด",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(adminAuditLog).values({
      ...base,
      summary: "ใหม่สุด",
      createdAt: new Date("2026-06-01T00:00:00Z"),
    });

    const log = await listAuditLog(admin.id);
    expect(log?.map((e) => e.summary)).toEqual(["ใหม่สุด", "เก่าสุด"]);
  });

  it("จำกัดจำนวนตาม limit", async () => {
    const admin = await makeUser("admin", "admin");
    const target = await makeUser("target");
    const base = buildAuditValues({ actor: admin, target, action: "set_status", summary: "x" });
    for (let i = 0; i < 5; i++) await db.insert(adminAuditLog).values(base);
    expect(await listAuditLog(admin.id, { limit: 3 })).toHaveLength(3);
  });

  it("คืน outcome มาด้วย", async () => {
    const admin = await makeUser("admin", "admin");
    const target = await makeUser("target");
    await db.insert(adminAuditLog).values(
      buildAuditValues({ actor: admin, target, action: "set_status", summary: "x", outcome: "denied" }),
    );
    const log = await listAuditLog(admin.id);
    expect(log?.[0].outcome).toBe("denied");
  });
});

describe("recordDenied", () => {
  beforeEach(async () => {
    await db.delete(adminAuditLog);
    await db.delete(users);
  });

  it("บันทึกแถว outcome=denied พร้อม snapshot username ทั้งสองฝั่ง", async () => {
    const attacker = await makeUser("attacker");
    const victim = await makeUser("victim");
    await recordDenied({
      actorId: attacker.id,
      targetId: victim.id,
      action: "reset_password",
      reason: "พยายามยึดบัญชี",
    });
    const [row] = await db.select().from(adminAuditLog);
    expect(row).toMatchObject({
      actorId: attacker.id,
      actorUsername: "attacker",
      targetId: victim.id,
      targetUsername: "victim",
      action: "reset_password",
      outcome: "denied",
      summary: "พยายามยึดบัญชี",
    });
  });

  it("targetId เป็น null ได้ (ไม่ระบุเป้าหมาย)", async () => {
    const attacker = await makeUser("attacker");
    await recordDenied({ actorId: attacker.id, action: "set_status", reason: "x" });
    const [row] = await db.select().from(adminAuditLog);
    expect(row.targetId).toBeNull();
    expect(row.targetUsername).toBe("(ไม่ระบุ)");
  });
});

describe("pruneAuditLog", () => {
  beforeEach(async () => {
    await db.delete(adminAuditLog);
    await db.delete(users);
  });

  async function seed(n: number) {
    const admin = await makeUser("admin", "admin");
    const target = await makeUser("target");
    const base = buildAuditValues({ actor: admin, target, action: "set_status", summary: "x" });
    for (let i = 0; i < n; i++) {
      await db.insert(adminAuditLog).values({ ...base, createdAt: new Date(2026, 0, 1, 0, i) });
    }
  }

  it("เก็บแค่ใหม่สุด max แถว ที่เหลือลบทิ้ง", async () => {
    await seed(10);
    await pruneAuditLog(4);
    const rows = await db.select().from(adminAuditLog);
    expect(rows).toHaveLength(4);
  });

  it("เก็บ 'ใหม่สุด' จริง (แถวเก่าถูกลบ ไม่ใช่แถวใหม่)", async () => {
    await seed(6);
    await pruneAuditLog(2);
    const rows = await db
      .select()
      .from(adminAuditLog)
      .orderBy(adminAuditLog.createdAt);
    // เหลือสองแถวที่มี createdAt นาทีที่ 4 และ 5 (ใหม่สุด)
    expect(rows.map((r) => r.createdAt.getMinutes())).toEqual([4, 5]);
  });

  it("ไม่ทำอะไรถ้ายังไม่เกิน max", async () => {
    await seed(3);
    await pruneAuditLog(10);
    expect(await db.select().from(adminAuditLog)).toHaveLength(3);
  });
});
