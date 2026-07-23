import type { AiCallDTO, AiHealth as Health, AiStatsSummary } from "@/lib/ai-stats";

const HEALTH_META: Record<Health, { label: string; icon: string; box: string }> = {
  ok: {
    label: "ปกติ",
    icon: "✅",
    box: "border-green-300 bg-green-50 dark:border-green-900/60 dark:bg-green-900/20",
  },
  degraded: {
    label: "เริ่มเสื่อม",
    icon: "⚠️",
    box: "border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-900/20",
  },
  down: {
    label: "ใช้งานไม่ได้",
    icon: "⛔",
    box: "border-red-300 bg-red-50 dark:border-red-900/60 dark:bg-red-900/20",
  },
  unknown: {
    label: "ยังไม่มีข้อมูล",
    icon: "—",
    box: "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/40",
  },
};

const pct = (n: number) => `${Math.round(n * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} วิ`;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-gray-400 dark:text-gray-500">{hint}</div>}
    </div>
  );
}

export function AiHealth({
  summary,
  recent,
  sinceHours,
}: {
  summary: AiStatsSummary;
  recent: AiCallDTO[];
  sinceHours: number;
}) {
  const meta = HEALTH_META[summary.health];

  return (
    <>
      <div className={`mb-4 rounded-xl border p-4 ${meta.box}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden>{meta.icon}</span>
          <span className="font-semibold">สถานะ: {meta.label}</span>
          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
            {sinceHours} ชั่วโมงล่าสุด
          </span>
        </div>
        {summary.reasons.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-sm text-gray-700 dark:text-gray-300">
            {summary.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {summary.lastError && (
          <p className="mt-2 break-words rounded bg-white/60 px-2 py-1 font-mono text-xs text-red-700 dark:bg-black/30 dark:text-red-300">
            error ล่าสุด: {summary.lastError}
          </p>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="อัตราสำเร็จ"
          value={summary.totalCalls === 0 ? "–" : pct(summary.successRate)}
          hint={`${summary.okCalls}/${summary.totalCalls} ครั้ง`}
        />
        <Stat
          label="ความครบของผล"
          value={summary.totalCalls === 0 ? "–" : pct(summary.completeness)}
          hint={`ได้ ${summary.returned}/${summary.requested} ข่าว`}
        />
        <Stat
          label="เวลาต่อข่าว"
          value={summary.totalCalls === 0 ? "–" : secs(summary.avgMsPerArticle)}
          hint={`เฉลี่ย ${secs(summary.avgDurationMs)}/ครั้ง`}
        />
        <Stat
          label="ล้มเหลว"
          value={String(summary.failedCalls)}
          hint={summary.failedCalls > 0 ? "ดูรายการด้านล่าง" : "ไม่มี"}
        />
      </div>

      {recent.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          ยังไม่มีการเรียก AI ในช่วงเวลานี้
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-xs text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3 font-medium">เวลา</th>
                <th className="py-2 pr-3 font-medium">หัวข้อ</th>
                <th className="py-2 pr-3 font-medium">โหมด</th>
                <th className="py-2 pr-3 text-right font-medium">ผล/ที่ขอ</th>
                <th className="py-2 pr-3 text-right font-medium">เวลา</th>
                <th className="py-2 font-medium">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => {
                const incomplete = c.ok && c.returned < c.requested;
                return (
                  <tr key={c.id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-3 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                      {new Date(c.createdAt).toLocaleString("th-TH", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="py-2 pr-3">{c.topicName}</td>
                    <td className="py-2 pr-3 text-xs text-gray-500 dark:text-gray-400">
                      {c.mode === "batch" ? "ชุด" : "เดี่ยว"}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right tabular-nums ${
                        incomplete ? "font-semibold text-amber-600 dark:text-amber-400" : ""
                      }`}
                    >
                      {c.returned}/{c.requested}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-gray-500 dark:text-gray-400">
                      {secs(c.durationMs)}
                    </td>
                    <td className="py-2">
                      {!c.ok ? (
                        <span
                          className="text-red-600 dark:text-red-400"
                          title={c.errorMessage ?? undefined}
                        >
                          ⛔ ล้มเหลว
                        </span>
                      ) : incomplete ? (
                        <span className="text-amber-600 dark:text-amber-400">⚠️ ตอบไม่ครบ</span>
                      ) : (
                        <span className="text-green-600 dark:text-green-400">✅ สำเร็จ</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
