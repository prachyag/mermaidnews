import { beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLog, sessions, users, type UserRole, type UserStatus } from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";
import { createSession, resolveUserId } from "./session";
import {
  isSettableStatus,
  listUsers,
  setUserAccess,
  setUserPassword,
  setUserRole,
  toManagedUserDTO,
} from "./admin";

const PASSWORD = "correct-horse-8";

async function makeUser(input: {
  username: string;
  role?: UserRole;
  status?: UserStatus;
  accessExpiresAt?: Date | null;
}) {
  const [user] = await db
    .insert(users)
    .values({
      username: input.username,
      role: input.role ?? "user",
      status: input.status ?? "pending",
      accessExpiresAt: input.accessExpiresAt ?? null,
      passwordHash: hashPassword(PASSWORD),
    })
    .returning();
  return user;
}

let admin: Awaited<ReturnType<typeof makeUser>>;
let member: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  await db.delete(adminAuditLog);
  await db.delete(users);
  admin = await makeUser({ username: "admin", role: "admin", status: "active" });
  member = await makeUser({ username: "member" });
});

/** อ่าน audit ทั้งหมด ใหม่สุดก่อน — ใช้ตรวจว่า mutation เขียน log ถูกต้อง */
async function auditRows() {
  return db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id));
}

describe("isSettableStatus", () => {
  it.each(["pending", "active", "revoked"])("รับ %s", (value) => {
    expect(isSettableStatus(value)).toBe(true);
  });

  it.each([["admin"], ["deleted"], [""], [null], [undefined], [1], [{}]])(
    "ปฏิเสธ %s",
    (value) => {
      expect(isSettableStatus(value)).toBe(false);
    },
  );
});

describe("toManagedUserDTO", () => {
  it("ไม่ส่ง passwordHash ออกไป", () => {
    expect(JSON.stringify(toManagedUserDTO(member))).not.toContain(member.passwordHash);
  });

  it("สรุป usable ให้ (active หมดอายุแล้ว = ใช้ไม่ได้)", async () => {
    const expired = await makeUser({
      username: "expired",
      status: "active",
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    expect(toManagedUserDTO(expired).usable).toBe(false);
    expect(toManagedUserDTO(admin).usable).toBe(true);
  });
});

describe("สิทธิ์การเข้าถึง", () => {
  it("คนที่ไม่ใช่ admin ดูรายชื่อผู้ใช้ไม่ได้ = 403", async () => {
    expect(await listUsers(member.id)).toMatchObject({ ok: false, status: 403 });
  });

  it("คนที่ไม่ใช่ admin เปลี่ยนสถานะคนอื่นไม่ได้ = 403 และข้อมูลต้องไม่ถูกแก้", async () => {
    const victim = await makeUser({ username: "victim" });
    const res = await setUserAccess({
      actorId: member.id,
      targetId: victim.id,
      status: "active",
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
    const after = await db.query.users.findFirst({ where: eq(users.id, victim.id) });
    expect(after?.status).toBe("pending");
  });

  it("คนที่ไม่ใช่ admin ตั้งรหัสผ่านคนอื่นไม่ได้ = 403 (ไม่งั้นยึดบัญชีคนอื่นได้)", async () => {
    const victim = await makeUser({ username: "victim2" });
    const res = await setUserPassword({
      actorId: member.id,
      targetId: victim.id,
      newPassword: "hijacked-pass",
    });
    expect(res).toMatchObject({ ok: false, status: 403 });
    const after = await db.query.users.findFirst({ where: eq(users.id, victim.id) });
    expect(verifyPassword(PASSWORD, after!.passwordHash)).toBe(true);
  });

  it("admin ดูรายชื่อได้ครบทุกคน", async () => {
    const res = await listUsers(admin.id);
    if (!res.ok) throw new Error("ควรสำเร็จ");
    expect(res.data.map((u) => u.username)).toEqual(["admin", "member"]);
  });
});

describe("กันล็อกตัวเองออก", () => {
  it("admin เพิกถอนสิทธิ์ตัวเองไม่ได้ = 400", async () => {
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: admin.id,
      status: "revoked",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    const after = await db.query.users.findFirst({ where: eq(users.id, admin.id) });
    expect(after?.status).toBe("active");
  });

  it("admin ตั้งวันหมดอายุให้ตัวเองไม่ได้ = 400", async () => {
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: admin.id,
      accessExpiresAt: new Date(Date.now() + 1000),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    const after = await db.query.users.findFirst({ where: eq(users.id, admin.id) });
    expect(after?.accessExpiresAt).toBeNull();
  });

  it("admin ตั้งรหัสผ่านตัวเองผ่านหน้า admin ไม่ได้ = 400 (ใช้ /account แทน)", async () => {
    const res = await setUserPassword({
      actorId: admin.id,
      targetId: admin.id,
      newPassword: "brand-new-pass",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("admin เพิกถอนสิทธิ์ admin อีกคนไม่ได้ = 400", async () => {
    const other = await makeUser({ username: "admin2", role: "admin", status: "active" });
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: other.id,
      status: "revoked",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    const after = await db.query.users.findFirst({ where: eq(users.id, other.id) });
    expect(after?.status).toBe("active");
  });

  it("admin ยึดบัญชี admin อีกคนด้วยการตั้งรหัสผ่านใหม่ไม่ได้ = 400", async () => {
    const other = await makeUser({ username: "admin3", role: "admin", status: "active" });
    const res = await setUserPassword({
      actorId: admin.id,
      targetId: other.id,
      newPassword: "hijacked-pass",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    const after = await db.query.users.findFirst({ where: eq(users.id, other.id) });
    expect(verifyPassword(PASSWORD, after!.passwordHash)).toBe(true);
  });
});

describe("setUserAccess", () => {
  it("อนุมัติ pending -> active ทำให้ใช้งานได้จริง", async () => {
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      status: "active",
    });
    if (!res.ok) throw new Error("ควรสำเร็จ");
    expect(res.data.usable).toBe(true);

    const token = await createSession(member.id);
    expect(await resolveUserId(token)).toBe(member.id);
  });

  it("ตั้งวันหมดอายุในอนาคต = ยังใช้ได้", async () => {
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      status: "active",
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    if (!res.ok) throw new Error("ควรสำเร็จ");
    expect(res.data.usable).toBe(true);
  });

  it("ตั้งวันหมดอายุที่ผ่านมาแล้ว = ใช้ไม่ได้ทันที และ session ถูกเตะออก", async () => {
    await setUserAccess({ actorId: admin.id, targetId: member.id, status: "active" });
    const token = await createSession(member.id);
    expect(await resolveUserId(token)).toBe(member.id);

    await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    expect(await resolveUserId(token)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, member.id))).toHaveLength(0);
  });

  it("เพิกถอนสิทธิ์ = session ที่ล็อกอินค้างอยู่ต้องใช้ไม่ได้ทันที", async () => {
    await setUserAccess({ actorId: admin.id, targetId: member.id, status: "active" });
    const token = await createSession(member.id);
    expect(await resolveUserId(token)).toBe(member.id);

    await setUserAccess({ actorId: admin.id, targetId: member.id, status: "revoked" });
    expect(await resolveUserId(token)).toBeNull();
  });

  it("ล้างวันหมดอายุด้วย null = กลับมาใช้ได้ไม่มีกำหนด", async () => {
    await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      status: "active",
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      accessExpiresAt: null,
    });
    if (!res.ok) throw new Error("ควรสำเร็จ");
    expect(res.data.usable).toBe(true);
    expect(res.data.accessExpiresAt).toBeNull();
  });

  it("ไม่ส่ง accessExpiresAt มา = ไม่แตะค่าเดิม", async () => {
    const expiry = new Date(Date.now() + 60_000);
    await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      status: "active",
      accessExpiresAt: expiry,
    });
    await setUserAccess({ actorId: admin.id, targetId: member.id, status: "pending" });
    const after = await db.query.users.findFirst({ where: eq(users.id, member.id) });
    expect(after?.accessExpiresAt?.getTime()).toBe(expiry.getTime());
  });

  it("อนุมัติแล้วไม่แตะ session ของคนอื่น", async () => {
    const other = await makeUser({ username: "other", status: "active" });
    await createSession(other.id);
    await setUserAccess({ actorId: admin.id, targetId: member.id, status: "revoked" });
    expect(await db.select().from(sessions).where(eq(sessions.userId, other.id))).toHaveLength(1);
  });

  it("สถานะไม่ถูกต้อง = 400", async () => {
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      status: "superuser" as UserStatus,
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("วันหมดอายุที่ parse ไม่ได้ = 400", async () => {
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      accessExpiresAt: new Date("ไม่ใช่วันที่"),
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("ไม่ส่งอะไรมาแก้เลย = 400", async () => {
    expect(await setUserAccess({ actorId: admin.id, targetId: member.id })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("ไม่พบบัญชีเป้าหมาย = 404", async () => {
    const res = await setUserAccess({
      actorId: admin.id,
      targetId: 999999,
      status: "active",
    });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});

describe("setUserPassword", () => {
  it("admin ตั้งรหัสผ่านใหม่ให้คนอื่นได้ โดยไม่ต้องรู้รหัสเดิม", async () => {
    const res = await setUserPassword({
      actorId: admin.id,
      targetId: member.id,
      newPassword: "reset-by-admin",
    });
    expect(res.ok).toBe(true);
    const after = await db.query.users.findFirst({ where: eq(users.id, member.id) });
    expect(verifyPassword("reset-by-admin", after!.passwordHash)).toBe(true);
  });

  it("ตั้งรหัสผ่านใหม่ = เตะ session เดิมของเจ้าของบัญชีออก", async () => {
    await setUserAccess({ actorId: admin.id, targetId: member.id, status: "active" });
    const token = await createSession(member.id);
    await setUserPassword({
      actorId: admin.id,
      targetId: member.id,
      newPassword: "reset-by-admin",
    });
    expect(await resolveUserId(token)).toBeNull();
  });

  it("รหัสผ่านสั้นเกิน = 400 และรหัสเดิมต้องยังใช้ได้", async () => {
    const res = await setUserPassword({
      actorId: admin.id,
      targetId: member.id,
      newPassword: "short7c",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
    const after = await db.query.users.findFirst({ where: eq(users.id, member.id) });
    expect(verifyPassword(PASSWORD, after!.passwordHash)).toBe(true);
  });

  it("ไม่พบบัญชีเป้าหมาย = 404", async () => {
    const res = await setUserPassword({
      actorId: admin.id,
      targetId: 999999,
      newPassword: "reset-by-admin",
    });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});

describe("setUserRole", () => {
  it("คนที่ไม่ใช่ admin เลื่อนขั้นใครไม่ได้ = 403", async () => {
    const res = await setUserRole({ actorId: member.id, targetId: member.id, role: "admin" });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("เลื่อน user -> admin ได้ และบัญชีนั้นใช้งานได้ทันที (active + ล้างวันหมดอายุ)", async () => {
    const pendingUser = await makeUser({
      username: "promote-me",
      status: "pending",
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    const res = await setUserRole({
      actorId: admin.id,
      targetId: pendingUser.id,
      role: "admin",
    });
    if (!res.ok) throw new Error("ควรสำเร็จ");
    expect(res.data).toMatchObject({ role: "admin", status: "active", usable: true });

    const after = await db.query.users.findFirst({ where: eq(users.id, pendingUser.id) });
    expect(after?.role).toBe("admin");
    expect(after?.status).toBe("active");
    expect(after?.accessExpiresAt).toBeNull();
  });

  it("เลื่อนขั้นแล้วบัญชีนั้นใช้ endpoint ของ admin ได้จริง (เห็นรายชื่อผู้ใช้)", async () => {
    await setUserRole({ actorId: admin.id, targetId: member.id, role: "admin" });
    const res = await listUsers(member.id);
    expect(res.ok).toBe(true);
  });

  it("admin เปลี่ยน role ตัวเองไม่ได้ = 400 (กันลดขั้นตัวเองจนไม่มีสิทธิ์)", async () => {
    const res = await setUserRole({ actorId: admin.id, targetId: admin.id, role: "user" });
    expect(res).toMatchObject({ ok: false, status: 400 });
    const after = await db.query.users.findFirst({ where: eq(users.id, admin.id) });
    expect(after?.role).toBe("admin");
  });

  it("ลดขั้น admin -> user ได้ ถ้ายังเหลือ admin คนอื่น (นี่คือทาง recovery)", async () => {
    const other = await makeUser({ username: "admin2", role: "admin", status: "active" });
    const res = await setUserRole({ actorId: admin.id, targetId: other.id, role: "user" });
    if (!res.ok) throw new Error("ควรสำเร็จ");
    expect(res.data.role).toBe("user");
  });

  it("ลดขั้น admin คนสุดท้ายไม่ได้ = 400 (ระบบต้องเหลือ admin อย่างน้อยหนึ่งคน)", async () => {
    // มี admin แค่คนเดียวคือ actor เอง — จะลดขั้น admin คนอื่นก็ไม่มี ทดสอบผ่านการมี 2 คนแล้วลดทีละคน
    const other = await makeUser({ username: "admin2", role: "admin", status: "active" });
    // ลดคนที่สองได้ (เหลือ actor เป็น admin)
    expect((await setUserRole({ actorId: admin.id, targetId: other.id, role: "user" })).ok).toBe(
      true,
    );
    // ตอนนี้เหลือ admin คนเดียว (actor) — ลดใครไม่ได้อีก เพราะ actor ลดตัวเองไม่ได้อยู่แล้ว
    // จำลองอีกมุม: admin คนที่ 2 ลดคนแรก (actor) เป็น user เมื่อเหลือ 2 คน ได้ แต่พอเหลือคนเดียวห้าม
    const admin3 = await makeUser({ username: "admin3", role: "admin", status: "active" });
    // ตอนนี้ admin = [admin(actor), admin3] (other ถูกลดไปแล้ว) → 2 คน
    // admin3 ลด actor ได้ (เหลือ admin3 คนเดียว)
    expect((await setUserRole({ actorId: admin3.id, targetId: admin.id, role: "user" })).ok).toBe(
      true,
    );
    // เหลือ admin3 คนเดียว — ไม่มี admin คนอื่นให้ลด และ admin3 ลดตัวเองไม่ได้
    const res = await setUserRole({ actorId: admin3.id, targetId: admin3.id, role: "user" });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("role ไม่ถูกต้อง = 400", async () => {
    const res = await setUserRole({
      actorId: admin.id,
      targetId: member.id,
      role: "superuser" as "admin" | "user",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("ไม่พบบัญชีเป้าหมาย = 404", async () => {
    const res = await setUserRole({ actorId: admin.id, targetId: 999999, role: "admin" });
    expect(res).toMatchObject({ ok: false, status: 404 });
  });

  it("ลดขั้น admin -> user ไม่ต้องเตะ session (ยังเป็นผู้ใช้ปกติที่ใช้งานได้)", async () => {
    const other = await makeUser({ username: "admin2", role: "admin", status: "active" });
    await createSession(other.id);
    await setUserRole({ actorId: admin.id, targetId: other.id, role: "user" });
    // ยัง active อยู่ — resolveUserId ยังคืน id ได้ แต่ role จะเป็น user (nav/admin API กันเอง)
    expect(await db.select().from(sessions).where(eq(sessions.userId, other.id))).toHaveLength(1);
  });
});

describe("audit log — บันทึกทุกการกระทำที่สำเร็จ", () => {
  it("อนุมัติ (setUserAccess) เขียน 1 แถว action=set_status พร้อม username ทั้งสองฝั่ง", async () => {
    await setUserAccess({ actorId: admin.id, targetId: member.id, status: "active" });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.id,
      actorUsername: "admin",
      targetId: member.id,
      targetUsername: "member",
      action: "set_status",
    });
    expect(rows[0].summary).toContain("active");
  });

  it("ตั้งวันหมดอายุอย่างเดียว action=set_access_expiry", async () => {
    await setUserAccess({
      actorId: admin.id,
      targetId: member.id,
      accessExpiresAt: new Date("2027-01-01T00:00:00Z"),
    });
    const rows = await auditRows();
    expect(rows[0].action).toBe("set_access_expiry");
    expect(rows[0].summary).toContain("2027");
  });

  it("เลื่อนขั้น action=promote_admin, ลดขั้น action=demote_user", async () => {
    await setUserRole({ actorId: admin.id, targetId: member.id, role: "admin" });
    const other = await makeUser({ username: "admin2", role: "admin", status: "active" });
    await setUserRole({ actorId: admin.id, targetId: other.id, role: "user" });
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(["demote_user", "promote_admin"]); // ใหม่สุดก่อน
  });

  it("รีเซ็ตรหัสผ่าน action=reset_password และไม่บันทึกค่ารหัสผ่านลง log", async () => {
    await setUserPassword({ actorId: admin.id, targetId: member.id, newPassword: "secret-abc-123" });
    const rows = await auditRows();
    expect(rows[0]).toMatchObject({ action: "reset_password", targetUsername: "member" });
    expect(JSON.stringify(rows)).not.toContain("secret-abc-123");
  });

  it("การกระทำที่ล้มเหลว (รหัสผ่านสั้นเกิน) ต้องไม่เขียน audit", async () => {
    await setUserPassword({ actorId: admin.id, targetId: member.id, newPassword: "short7c" });
    expect(await auditRows()).toHaveLength(0);
  });

  it("แก้บัญชีตัวเองไม่สำเร็จ ต้องไม่เขียน audit (แค่พลาด ไม่ใช่บุกรุก)", async () => {
    await setUserAccess({ actorId: admin.id, targetId: admin.id, status: "revoked" });
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("audit log — บันทึกความพยายามที่ถูกปฏิเสธ (denied)", () => {
  it("คนที่ไม่ใช่ admin พยายามเปลี่ยนสถานะคนอื่น = บันทึก denied พร้อมชื่อผู้พยายาม", async () => {
    const victim = await makeUser({ username: "victim" });
    await setUserAccess({ actorId: member.id, targetId: victim.id, status: "active" });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: member.id,
      actorUsername: "member",
      targetUsername: "victim",
      action: "set_status",
      outcome: "denied",
    });
  });

  it("คนที่ไม่ใช่ admin พยายามเลื่อนขั้นตัวเอง = บันทึก denied action=promote_admin", async () => {
    await setUserRole({ actorId: member.id, targetId: member.id, role: "admin" });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied", action: "promote_admin" });
  });

  it("admin พยายามแก้บัญชี admin อื่น = บันทึก denied", async () => {
    const other = await makeUser({ username: "admin2", role: "admin", status: "active" });
    await setUserPassword({ actorId: admin.id, targetId: other.id, newPassword: "hijack-attempt" });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied", action: "reset_password" });
    expect(JSON.stringify(rows)).not.toContain("hijack-attempt");
  });

  it("แก้บัญชีตัวเอง (self) ไม่บันทึก denied — เป็นความพลาด ไม่ใช่บุกรุก", async () => {
    await setUserAccess({ actorId: admin.id, targetId: admin.id, status: "revoked" });
    await setUserPassword({ actorId: admin.id, targetId: admin.id, newPassword: "some-new-pass" });
    expect(await auditRows()).toHaveLength(0);
  });

  it("validation ผิด (รหัสผ่านสั้น) จาก admin ตัวจริง = ไม่บันทึก (ไม่ใช่ปัญหาสิทธิ์)", async () => {
    await setUserPassword({ actorId: admin.id, targetId: member.id, newPassword: "short7c" });
    expect(await auditRows()).toHaveLength(0);
  });
});
