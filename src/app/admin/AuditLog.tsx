import type { AuditEntryDTO } from "@/lib/audit";
import type { AdminAction } from "@/db/schema";

/** ไอคอน + สีต่อชนิดการกระทำ ให้กวาดตาเห็นได้เร็วว่าเกิดอะไรขึ้น */
const ACTION_META: Record<AdminAction, { icon: string; tone: string }> = {
  promote_admin: { icon: "⬆️", tone: "text-purple-700 dark:text-purple-300" },
  demote_user: { icon: "⬇️", tone: "text-gray-700 dark:text-gray-300" },
  set_status: { icon: "🔄", tone: "text-blue-700 dark:text-blue-300" },
  set_access_expiry: { icon: "⏳", tone: "text-amber-700 dark:text-amber-300" },
  reset_password: { icon: "🔑", tone: "text-red-700 dark:text-red-300" },
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export function AuditLog({ entries }: { entries: AuditEntryDTO[] }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
        ยังไม่มีประวัติการดำเนินการ
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((e) => {
        const meta = ACTION_META[e.action] ?? { icon: "•", tone: "" };
        const denied = e.outcome === "denied";
        return (
          <li
            key={e.id}
            className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-sm ${
              denied
                ? "border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-900/20"
                : "border-gray-200 dark:border-gray-700"
            }`}
          >
            <span aria-hidden>{denied ? "⛔" : meta.icon}</span>
            {denied && (
              <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                ถูกปฏิเสธ
              </span>
            )}
            <span className={`font-semibold ${denied ? "text-red-700 dark:text-red-300" : meta.tone}`}>
              {e.actorUsername}
            </span>
            <span className="text-gray-600 dark:text-gray-300">{e.summary}</span>
            <span className="text-gray-500 dark:text-gray-400">
              → <span className="font-medium">{e.targetUsername}</span>
            </span>
            <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
              {formatWhen(e.createdAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
