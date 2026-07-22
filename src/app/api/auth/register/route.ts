import { NextRequest, NextResponse } from "next/server";
import { count, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { topics, users } from "@/db/schema";
import { createSession, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/session";
import { hashPassword } from "@/lib/password";
import { isRegistrationOpen } from "@/lib/registration";
import { isValidEmail, normalizeEmail } from "@/lib/email";
import { MIN_PASSWORD_LENGTH } from "@/lib/account";
import { clientIdentifier, isRateLimited, recordFailedAttempt } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** POST /api/auth/register — สมัครบัญชีใหม่แล้วล็อกอินให้เลย */
export async function POST(req: NextRequest) {
  const identifier = clientIdentifier(req);
  if (await isRateLimited(identifier)) {
    return NextResponse.json(
      { error: "พยายามบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่" },
      { status: 429 },
    );
  }

  if (!(await isRegistrationOpen())) {
    await recordFailedAttempt(identifier);
    return NextResponse.json(
      { error: "ระบบปิดรับสมัครสมาชิกใหม่อยู่" },
      { status: 403 },
    );
  }

  let body: { username?: string; password?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "body ไม่ใช่ JSON" }, { status: 400 });
  }

  const username = body.username?.trim().toLowerCase();
  const password = body.password ?? "";
  if (!username || username.length < 3 || !/^[a-z0-9_.-]+$/.test(username)) {
    return NextResponse.json(
      { error: "ชื่อผู้ใช้ต้องยาวอย่างน้อย 3 ตัว ใช้ได้เฉพาะ a-z 0-9 _ . -" },
      { status: 400 },
    );
  }
  if (!isValidEmail(body.email ?? "")) {
    return NextResponse.json({ error: "รูปแบบอีเมลไม่ถูกต้อง" }, { status: 400 });
  }
  const email = normalizeEmail(body.email!);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร` },
      { status: 400 },
    );
  }

  const existing = await db.query.users.findFirst({
    where: eq(users.username, username),
  });
  if (existing) {
    return NextResponse.json({ error: "ชื่อผู้ใช้นี้ถูกใช้แล้ว" }, { status: 409 });
  }
  const emailTaken = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (emailTaken) {
    return NextResponse.json({ error: "อีเมลนี้ถูกใช้แล้ว" }, { status: 409 });
  }

  /**
   * บัญชีแรกของระบบ = super admin และใช้งานได้ทันที (bootstrap — ไม่มีใครมาอนุมัติให้)
   * บัญชีถัด ๆ ไปเกิดเป็น pending ต้องรอ admin อนุมัติก่อนถึงใช้งานได้
   *
   * ทำใน transaction เพราะต้องนับจำนวนบัญชี "ก่อน" insert เพื่อรู้ว่าเป็นคนแรกไหม
   * ถ้านับนอก transaction คนสองคนสมัครพร้อมกันจะเห็น 0 ทั้งคู่แล้วได้ admin ทั้งคู่
   */
  const { created, isFirst } = await db.transaction(async (tx) => {
    const [{ value: existingUsers }] = await tx.select({ value: count() }).from(users);
    const first = existingUsers === 0;
    const [row] = await tx
      .insert(users)
      .values({
        username,
        email,
        passwordHash: hashPassword(password),
        role: first ? "admin" : "user",
        status: first ? "active" : "pending",
      })
      .returning();
    // บัญชีแรกรับข้อมูลเก่า (หัวข้อที่สร้างก่อนมีระบบบัญชี) ไปเป็นเจ้าของ
    if (first) {
      await tx.update(topics).set({ userId: row.id }).where(isNull(topics.userId));
    }
    return { created: row, isFirst: first };
  });

  if (!isFirst) {
    // ยังไม่ออก session ให้ — บัญชียังใช้งานไม่ได้จนกว่า admin จะอนุมัติ
    return NextResponse.json({
      ok: true,
      pending: true,
      username: created.username,
      message: "สมัครสมาชิกแล้ว — รอผู้ดูแลระบบอนุมัติก่อนจึงจะเข้าใช้งานได้",
    });
  }

  const res = NextResponse.json({ ok: true, pending: false, username: created.username });
  res.cookies.set(SESSION_COOKIE, await createSession(created.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
