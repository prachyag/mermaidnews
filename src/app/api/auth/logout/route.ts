import { NextRequest, NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

/** GET /api/auth/logout — เพิกถอน session ใน DB, ล้าง cookie แล้วพากลับหน้า login */
export async function GET(req: NextRequest) {
  await destroySession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
