import "./globals.css";

import { Geist, Geist_Mono } from "next/font/google";
import { SESSION_COOKIE, resolveUserId } from "@/lib/session";

import type { Metadata } from "next";
import { cookies } from "next/headers";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { verifyTokenOptimistic } from "@/lib/auth";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PostMaid",
  description: "รวบรวมข่าวตามหัวข้อที่สนใจ พร้อมเตรียมโพสลง Facebook",
};

type Viewer =
  | { kind: "guest" }
  | { kind: "user"; username: string; isAdmin: boolean }
  /** token ยังถูกต้องตามลายเซ็น แต่ใช้ไม่ได้แล้ว (ถูกเพิกถอนสิทธิ์ / สิทธิ์หมดอายุ / session ถูกลบ) */
  | { kind: "stale" };

/**
 * proxy ตรวจแค่ลายเซ็น token (แตะ DB ไม่ได้) จึงปล่อยคนที่ถือ token ถูกต้องแต่บัญชีใช้ไม่ได้แล้ว
 * ให้เดินมาถึงหน้าเว็บได้ API ทุกตัวกันไว้อีกชั้น (401) แต่ผู้ใช้จะเห็นหน้าเปล่า ๆ โดยไม่รู้สาเหตุ
 * ที่นี่คือจุดที่รู้ความจริงจาก DB จึงแยกกรณี "stale" ออกมาบอกให้ชัดแทนที่จะปล่อยหน้าเปล่า
 */
async function currentViewer(): Promise<Viewer> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { kind: "guest" };

  const userId = await resolveUserId(token);
  if (userId !== null) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (user) {
      return {
        kind: "user",
        username: user.username,
        isAdmin: user.role === "admin",
      };
    }
  }
  // token พังหรือหมดอายุตามลายเซ็น = แค่ยังไม่ล็อกอิน (proxy พาไปหน้า login อยู่แล้ว)
  return (await verifyTokenOptimistic(token))
    ? { kind: "stale" }
    : { kind: "guest" };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const viewer = await currentViewer();
  const user = viewer.kind === "user" ? viewer : null;
  return (
    <html
      lang="th"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="border-b border-gray-200 dark:border-gray-800">
          <div className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3 text-sm">
            <span className="font-semibold">PostMaid</span>
            {user && (
              <>
                <a
                  href="/"
                  className="text-gray-600 hover:underline dark:text-gray-300"
                >
                  ข่าว
                </a>
                <a
                  href="/topics"
                  className="text-gray-600 hover:underline dark:text-gray-300"
                >
                  จัดการหัวข้อ
                </a>
                {user.isAdmin && (
                  <a
                    href="/admin"
                    className="text-gray-600 hover:underline dark:text-gray-300"
                  >
                    จัดการผู้ใช้
                  </a>
                )}
                <a
                  href="/account"
                  className="ml-auto text-gray-500 hover:underline dark:text-gray-400"
                >
                  👤 {user.username}
                </a>
                <a
                  href="/api/auth/logout"
                  className="text-gray-600 hover:underline dark:text-gray-300"
                >
                  ออกจากระบบ
                </a>
              </>
            )}
          </div>
        </nav>
        {viewer.kind === "stale" ? <SessionEnded /> : children}
      </body>
    </html>
  );
}

/**
 * แทนที่ทุกหน้าเมื่อ session ใช้ไม่ได้แล้ว — ปุ่มออกจากระบบจะล้าง cookie ทิ้ง
 * ทำให้กลับไปหน้าล็อกอินได้ตามปกติ (ถ้าไม่ล้าง cookie จะวนอยู่ที่จอนี้)
 */
function SessionEnded() {
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 p-6 text-center dark:border-gray-700">
        <p className="mb-1 text-2xl">🔒</p>
        <h1 className="mb-2 text-lg font-bold">เซสชันนี้ใช้งานไม่ได้แล้ว</h1>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          บัญชีของคุณอาจถูกเพิกถอนสิทธิ์ สิทธิ์หมดอายุ หรือถูกให้ออกจากระบบ —
          ติดต่อผู้ดูแลระบบหากคิดว่าผิดพลาด
        </p>
        <a
          href="/api/auth/logout"
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          ออกจากระบบ
        </a>
      </div>
    </div>
  );
}
