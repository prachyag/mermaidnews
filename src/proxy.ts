import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifyTokenOptimistic } from "@/lib/auth";

const PUBLIC_PATHS = new Set([
  "/login",
  "/register",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
]);

/** ทุกหน้า/ทุก API ต้องล็อกอิน ยกเว้นหน้า auth — ข้อมูลถูก scope ตาม user อีกชั้นในแต่ละ route */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // optimistic check เท่านั้น (ไม่แตะ DB) — การเพิกถอน session ตรวจจริงใน DAL ที่ route/layout
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claim = token ? await verifyTokenOptimistic(token) : null;
  if (claim !== null) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "ต้องล็อกอินก่อน" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
