import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions, users } from "@/db/schema";
import { hashPassword, verifyPassword } from "./password";
import { createSession } from "./session";
import { changeEmail, changePassword, toAccountDTO } from "./account";

const PASSWORD = "correct-horse-8";

async function makeUser(overrides: { username: string; email?: string | null }) {
  const [user] = await db
    .insert(users)
    .values({
      username: overrides.username,
      email: overrides.email ?? null,
      passwordHash: hashPassword(PASSWORD),
    })
    .returning();
  return user;
}

beforeEach(async () => {
  await db.delete(users);
});

describe("toAccountDTO", () => {
  it("ไม่ส่ง passwordHash กลับไป client", async () => {
    const user = await makeUser({ username: "dto", email: "dto@example.com" });
    const dto = toAccountDTO(user);
    expect(dto).toEqual({ username: "dto", email: "dto@example.com" });
    expect(JSON.stringify(dto)).not.toContain(user.passwordHash);
  });
});

describe("changeEmail", () => {
  it("เปลี่ยนอีเมลได้เมื่อรหัสผ่านถูก", async () => {
    const user = await makeUser({ username: "a" });
    const res = await changeEmail({
      userId: user.id,
      currentPassword: PASSWORD,
      newEmail: "new@example.com",
    });
    expect(res.ok).toBe(true);
    const after = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    expect(after?.email).toBe("new@example.com");
  });

  it("เก็บอีเมลเป็นตัวพิมพ์เล็กเสมอ", async () => {
    const user = await makeUser({ username: "b" });
    await changeEmail({
      userId: user.id,
      currentPassword: PASSWORD,
      newEmail: "  MiXeD@Example.COM ",
    });
    const after = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    expect(after?.email).toBe("mixed@example.com");
  });

  it("รหัสผ่านผิด = 401 และอีเมลต้องไม่ถูกแก้", async () => {
    const user = await makeUser({ username: "c", email: "old@example.com" });
    const res = await changeEmail({
      userId: user.id,
      currentPassword: "wrong-password",
      newEmail: "attacker@evil.com",
    });
    expect(res).toMatchObject({ ok: false, status: 401 });
    const after = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    expect(after?.email).toBe("old@example.com");
  });

  it("อีเมลรูปแบบผิด = 400", async () => {
    const user = await makeUser({ username: "d" });
    const res = await changeEmail({
      userId: user.id,
      currentPassword: PASSWORD,
      newEmail: "not-an-email",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("อีเมลซ้ำกับบัญชีอื่น = 409", async () => {
    await makeUser({ username: "taken", email: "dup@example.com" });
    const user = await makeUser({ username: "e" });
    const res = await changeEmail({
      userId: user.id,
      currentPassword: PASSWORD,
      newEmail: "dup@example.com",
    });
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("อีเมลซ้ำแบบต่างตัวพิมพ์ก็ต้องกัน (409) — ไม่ใช่หลุดไปชน unique index", async () => {
    await makeUser({ username: "taken2", email: "dup2@example.com" });
    const user = await makeUser({ username: "f" });
    const res = await changeEmail({
      userId: user.id,
      currentPassword: PASSWORD,
      newEmail: "DUP2@Example.com",
    });
    expect(res).toMatchObject({ ok: false, status: 409 });
  });

  it("ตั้งอีเมลเดิมซ้ำได้ ไม่ฟ้องว่าซ้ำกับตัวเอง", async () => {
    const user = await makeUser({ username: "g", email: "same@example.com" });
    const res = await changeEmail({
      userId: user.id,
      currentPassword: PASSWORD,
      newEmail: "SAME@example.com",
    });
    expect(res.ok).toBe(true);
  });

  it("บัญชีถูกลบไปแล้ว = 401", async () => {
    const res = await changeEmail({
      userId: 999999,
      currentPassword: PASSWORD,
      newEmail: "x@example.com",
    });
    expect(res).toMatchObject({ ok: false, status: 401 });
  });
});

describe("changePassword", () => {
  it("เปลี่ยนรหัสผ่านได้ และรหัสใหม่ใช้ยืนยันผ่าน", async () => {
    const user = await makeUser({ username: "h" });
    const res = await changePassword({
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: "brand-new-pass",
    });
    expect(res.ok).toBe(true);
    const after = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    expect(verifyPassword("brand-new-pass", after!.passwordHash)).toBe(true);
    expect(verifyPassword(PASSWORD, after!.passwordHash)).toBe(false);
  });

  it("เพิกถอน session ทั้งหมดของ user นั้น", async () => {
    const user = await makeUser({ username: "i" });
    await createSession(user.id);
    await createSession(user.id);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(2);

    await changePassword({
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: "brand-new-pass",
    });
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });

  it("ไม่แตะ session ของ user อื่น", async () => {
    const me = await makeUser({ username: "j" });
    const other = await makeUser({ username: "k" });
    await createSession(other.id);

    await changePassword({
      userId: me.id,
      currentPassword: PASSWORD,
      newPassword: "brand-new-pass",
    });
    expect(await db.select().from(sessions).where(eq(sessions.userId, other.id))).toHaveLength(1);
  });

  it("รหัสผ่านปัจจุบันผิด = 401 และรหัสผ่านต้องไม่ถูกเปลี่ยน", async () => {
    const user = await makeUser({ username: "l" });
    const res = await changePassword({
      userId: user.id,
      currentPassword: "wrong-password",
      newPassword: "attacker-pass",
    });
    expect(res).toMatchObject({ ok: false, status: 401 });
    const after = await db.query.users.findFirst({ where: eq(users.id, user.id) });
    expect(verifyPassword(PASSWORD, after!.passwordHash)).toBe(true);
  });

  it("รหัสผ่านปัจจุบันผิด = ต้องไม่เตะ session ทิ้ง (ไม่งั้นกลายเป็นช่องทาง DoS)", async () => {
    const user = await makeUser({ username: "m" });
    await createSession(user.id);
    await changePassword({
      userId: user.id,
      currentPassword: "wrong-password",
      newPassword: "attacker-pass",
    });
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(1);
  });

  it("รหัสผ่านใหม่สั้นเกิน = 400", async () => {
    const user = await makeUser({ username: "n" });
    const res = await changePassword({
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: "short7c",
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("รหัสผ่านใหม่ซ้ำกับเดิม = 400", async () => {
    const user = await makeUser({ username: "o" });
    const res = await changePassword({
      userId: user.id,
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it("บัญชีถูกลบไปแล้ว = 401", async () => {
    const res = await changePassword({
      userId: 999999,
      currentPassword: PASSWORD,
      newPassword: "brand-new-pass",
    });
    expect(res).toMatchObject({ ok: false, status: 401 });
  });
});
