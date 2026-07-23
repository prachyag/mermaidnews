import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { resolveUserId, SESSION_COOKIE } from "@/lib/session";
import { listUsers } from "@/lib/admin";
import { AUDIT_LOG_MAX_ENTRIES, listAuditLog } from "@/lib/audit";
import { listRecentAiCalls, summarizeAiCalls } from "@/lib/ai-stats";
import { UserTable } from "./UserTable";
import { AuditLog } from "./AuditLog";
import { AiHealth } from "./AiHealth";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const userId = await resolveUserId((await cookies()).get(SESSION_COOKIE)?.value);
  if (userId === null) redirect("/login");

  // ใช้ DAL ตัวเดียวกับ API — คนที่ไม่ใช่ admin เดินมาหน้านี้เองจะไม่เห็นข้อมูลใคร
  const result = await listUsers(userId);
  if (!result.ok) redirect("/");
  const audit = (await listAuditLog(userId)) ?? [];
  const AI_STATS_HOURS = 24;
  const [aiSummary, aiRecent] = await Promise.all([
    summarizeAiCalls(userId, { sinceHours: AI_STATS_HOURS }),
    listRecentAiCalls(userId, { sinceHours: AI_STATS_HOURS, limit: 20 }),
  ]);

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="mb-1 text-xl font-bold">จัดการผู้ใช้</h1>
      <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
        บัญชีที่สมัครใหม่จะอยู่สถานะ &quot;รออนุมัติ&quot; และใช้งานไม่ได้จนกว่าคุณจะอนุมัติ
      </p>
      <UserTable initial={result.data} meId={userId} />

      <h2 className="mt-10 mb-1 text-lg font-bold">สุขภาพการเรียก AI</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        ดูว่าการต่อ AI กำลังเสื่อมหรือยัง — จับทั้งกรณีล้มเหลว และกรณี{" "}
        <span className="font-medium text-amber-600 dark:text-amber-400">
          &quot;สำเร็จแต่ตอบกลับไม่ครบ&quot;
        </span>{" "}
        ซึ่งไม่มี error แจ้งเตือน
      </p>
      <AiHealth summary={aiSummary} recent={aiRecent} sinceHours={AI_STATS_HOURS} />

      <h2 className="mt-10 mb-1 text-lg font-bold">ประวัติการดำเนินการ</h2>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        บันทึกทุกครั้งที่ผู้ดูแลระบบเปลี่ยนสถานะ สิทธิ์ ระดับ หรือรหัสผ่านของบัญชีอื่น
        รวมถึง <span className="font-medium text-red-600 dark:text-red-400">ความพยายามที่ถูกปฏิเสธ</span>{" "}
        — เก็บ {AUDIT_LOG_MAX_ENTRIES.toLocaleString("th-TH")} รายการล่าสุด ที่เก่ากว่านั้นถูกลบอัตโนมัติ
      </p>
      <AuditLog entries={audit} />
    </main>
  );
}
