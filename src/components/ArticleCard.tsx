"use client";

import { useState } from "react";
import { statusBadge, statusLabel } from "@/lib/article-status";

export type ArticleRow = {
  id: number;
  topicId: number;
  topicName: string;
  title: string;
  url: string;
  /** ลิงก์เว็บข่าวจริงที่แกะจาก url แล้ว — null = ยังไม่ได้แกะ */
  resolvedUrl: string | null;
  source: string | null;
  publishedAt: string | null;
  description: string | null;
  status: string;
  relevanceScore: number | null;
  summary: string | null;
  caption: string | null;
  hashtags: string[] | null;
  fbPostUrl: string | null;
  postedAt: string | null;
  scheduledAt: string | null;
  createdAt: string;
};

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ArticleCard({
  article,
  onChanged,
}: {
  article: ArticleRow;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(article.caption ?? "");
  const [hashtags, setHashtags] = useState((article.hashtags ?? []).join(" "));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleTime, setScheduleTime] = useState("");
  const [copied, setCopied] = useState(false);
  /** ใช้ตอน navigator.clipboard ใช้ไม่ได้ — โชว์กล่องข้อความให้เลือกคัดลอกเอง */
  const [manualCopyText, setManualCopyText] = useState<string | null>(null);

  /**
   * ข้อความสำหรับโพสเอง — ต้องมี URL อยู่ในตัวข้อความด้วย
   * (ต่างจากตอนยิง API ที่ส่ง link แยกเป็นอีกพารามิเตอร์ Facebook เลยดึง preview ให้เอง)
   */
  function buildShareText(link: string): string {
    return [article.caption ?? "", (article.hashtags ?? []).join(" "), link]
      .filter((s) => s.trim().length > 0)
      .join("\n\n");
  }

  async function copyPost() {
    setError(null);

    // ต้องได้ลิงก์เว็บข่าวจริง ไม่งั้นวางบน Facebook แล้วขึ้นการ์ด "Google News"
    let link = article.resolvedUrl ?? article.url;
    let warn: string | null = null;
    if (!article.resolvedUrl) {
      setBusy("copy");
      try {
        const res = await fetch(`/api/articles/${article.id}/resolve-url`, {
          method: "POST",
        });
        const data = await res.json();
        if (res.ok) {
          link = data.url ?? link;
          warn = data.warning ?? null;
        }
      } catch {
        // แกะไม่ได้ก็ใช้ลิงก์เดิม — การคัดลอกต้องไม่พังเพราะเรื่องนี้
      } finally {
        setBusy(null);
      }
    }

    const text = buildShareText(link);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setManualCopyText(null);
      if (warn) setError(warn);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // เบราว์เซอร์บล็อก clipboard (ไม่ใช่ https หรือไม่ได้ให้สิทธิ์) — ให้คัดลอกเองจากกล่อง
      setManualCopyText(text);
      setError("เบราว์เซอร์ไม่ให้คัดลอกอัตโนมัติ — เลือกข้อความในกล่องด้านล่างแล้วกด Ctrl+C");
    }
  }

  async function markPosted() {
    setBusy("markPosted");
    setError(null);
    try {
      const res = await fetch(`/api/articles/${article.id}/mark-posted`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "เกิดข้อผิดพลาด");
        return;
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const fbNote =
      article.status === "posted" && article.fbPostUrl
        ? "\n\n(โพสต์บน Facebook จะยังอยู่ — ลบแค่ระเบียนในระบบนี้)"
        : "";
    if (
      !window.confirm(
        `ลบ "${article.title}" ถาวร?\n\n` +
          `ข่าวนี้จะถูกบล็อก ไม่ถูกดึงกลับมาอีกแม้จะยังอยู่ในฟีด RSS\n` +
          `(เปลี่ยนใจได้ที่หน้าจัดการหัวข้อ → "🚫 รายการที่บล็อกไว้")${fbNote}`,
      )
    ) {
      return;
    }

    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(`/api/articles/${article.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "ลบไม่สำเร็จ");
        return;
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function patch(body: Record<string, unknown>, action: string) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/articles/${article.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "เกิดข้อผิดพลาด");
        return false;
      }
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  /**
   * สั่งเขียนแคปชันแบบยาวให้ข่าวนี้ — ระบบไปอ่านเนื้อข่าวจากเว็บจริงมาเป็นวัตถุดิบ
   * ใช้เมื่อข่าวนี้ไม่ได้ถูก AI เลือกให้อยู่ในกลุ่มข่าวเด่น แต่เราอยากได้แคปชันยาว
   */
  async function longForm() {
    setBusy("longForm");
    setError(null);
    try {
      const res = await fetch(`/api/articles/${article.id}/long-form`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "เขียนแคปชันยาวไม่สำเร็จ");
        return;
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function reprocess() {
    setBusy("reprocess");
    setError(null);
    try {
      const res = await fetch(`/api/articles/${article.id}/reprocess`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "เกิดข้อผิดพลาด");
        return;
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function publish(scheduledAt?: string) {
    setBusy("publish");
    setError(null);
    try {
      const res = await fetch(`/api/articles/${article.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scheduledAt ? { scheduledAt } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "โพสไม่สำเร็จ");
        onChanged();
        return;
      }
      // โพสสำเร็จ แต่อาจแกะลิงก์จริงไม่ได้ — ต้องบอกให้รู้ว่าการ์ดพรีวิวจะไม่สวย
      if (data.warning) setError(data.warning);
      setScheduling(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function submitSchedule() {
    if (!scheduleTime) {
      setError("เลือกวันเวลาที่จะโพสก่อน");
      return;
    }
    publish(new Date(scheduleTime).toISOString());
  }

  async function saveEdit() {
    const ok = await patch(
      {
        caption,
        hashtags: hashtags.split(/[\s,]+/).filter(Boolean),
      },
      "save",
    );
    if (ok) setEditing(false);
  }

  const btn =
    "rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <li className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-purple-100 px-2 py-0.5 font-medium text-purple-800 dark:bg-purple-900 dark:text-purple-200">
          {article.topicName}
        </span>
        <span className={`rounded-full px-2 py-0.5 ${statusBadge(article.status)}`}>
          {statusLabel(article.status)}
        </span>
      </div>

      {/* ถ้าแกะลิงก์จริงไว้แล้วก็พาไปเว็บข่าวตรง ๆ ไม่ต้องผ่านหน้า redirect ของ google */}
      <a
        href={article.resolvedUrl ?? article.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium hover:underline"
      >
        {article.title}
      </a>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {article.source ?? "ไม่ระบุแหล่ง"} • เผยแพร่ {formatDate(article.publishedAt)}
        {article.relevanceScore != null &&
          ` • ความเกี่ยวข้อง ${Math.round(article.relevanceScore * 100)}%`}
      </p>

      {article.summary && !editing && (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {article.summary}
        </p>
      )}

      {article.caption && !editing && (
        <div className="mt-2 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-800/60">
          <p className="mb-1 text-xs font-medium text-gray-400">✏️ แคปชันพร้อมโพส</p>
          <p className="whitespace-pre-wrap">{article.caption}</p>
          {article.hashtags && article.hashtags.length > 0 && (
            <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">
              {article.hashtags.join(" ")}
            </p>
          )}
        </div>
      )}

      {editing && (
        <div className="mt-2 space-y-2">
          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            rows={5}
            className="w-full rounded-lg border border-gray-300 p-3 text-sm dark:border-gray-600 dark:bg-gray-800"
            placeholder="แคปชันสำหรับโพส"
          />
          <input
            value={hashtags}
            onChange={(e) => setHashtags(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
            placeholder="แฮชแท็ก คั่นด้วยเว้นวรรค เช่น #นางเงือก #mermaid"
          />
          <div className="flex gap-2">
            <button
              onClick={saveEdit}
              disabled={busy !== null}
              className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}
            >
              {busy === "save" ? "กำลังบันทึก..." : "บันทึก"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setCaption(article.caption ?? "");
                setHashtags((article.hashtags ?? []).join(" "));
              }}
              disabled={busy !== null}
              className={`${btn} border border-gray-300 dark:border-gray-600`}
            >
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      {manualCopyText && (
        <textarea
          readOnly
          rows={6}
          value={manualCopyText}
          onFocus={(e) => e.currentTarget.select()}
          className="mt-2 w-full rounded-lg border border-gray-300 p-3 text-sm dark:border-gray-600 dark:bg-gray-800"
        />
      )}

      {scheduling && !editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            value={scheduleTime}
            onChange={(e) => setScheduleTime(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800"
          />
          <button
            onClick={submitSchedule}
            disabled={busy !== null}
            className="rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {busy === "publish" ? "⏳ กำลังตั้งเวลา..." : "ยืนยันตั้งเวลา"}
          </button>
          <span className="text-xs text-gray-400">
            (ล่วงหน้าอย่างน้อย 10 นาที ตามข้อกำหนดของ Facebook)
          </span>
        </div>
      )}

      {!editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          {article.caption && (
            <button
              onClick={copyPost}
              disabled={busy !== null}
              className={`${btn} border border-gray-300 dark:border-gray-600`}
              title="คัดลอกแคปชัน + แฮชแท็ก + ลิงก์ข่าวจริง ไปวางบน Facebook เอง (ไม่ต้องตั้ง Page ID/token)"
            >
              {busy === "copy"
                ? "⏳ กำลังหาลิงก์ข่าว..."
                : copied
                  ? "✅ คัดลอกแล้ว"
                  : "📋 คัดลอกโพสต์"}
            </button>
          )}

          {article.status === "draft" && (
            <>
              <button
                onClick={() => patch({ status: "approved" }, "approve")}
                disabled={busy !== null}
                className={`${btn} bg-green-600 text-white hover:bg-green-700`}
              >
                {busy === "approve" ? "..." : "✅ อนุมัติ"}
              </button>
              <button
                onClick={() => setEditing(true)}
                disabled={busy !== null}
                className={`${btn} border border-gray-300 dark:border-gray-600`}
              >
                ✏️ แก้ไขแคปชัน
              </button>
              <button
                onClick={() => patch({ status: "rejected" }, "reject")}
                disabled={busy !== null}
                className={`${btn} border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950`}
              >
                {busy === "reject" ? "..." : "🚫 ปฏิเสธ"}
              </button>
            </>
          )}

          {(article.status === "approved" || article.status === "failed") && (
            <>
              <button
                onClick={() => publish()}
                disabled={busy !== null}
                className={`${btn} bg-blue-600 text-white hover:bg-blue-700`}
              >
                {busy === "publish"
                  ? "⏳ กำลังโพส..."
                  : article.status === "failed"
                    ? "🔁 ลองโพสใหม่"
                    : "🚀 โพสทันที"}
              </button>
              <button
                onClick={() => setScheduling((v) => !v)}
                disabled={busy !== null}
                className={`${btn} border border-gray-300 dark:border-gray-600`}
              >
                🕐 ตั้งเวลาโพส
              </button>
              <button
                onClick={markPosted}
                disabled={busy !== null}
                className={`${btn} border border-gray-300 dark:border-gray-600`}
                title="สำหรับคนที่คัดลอกไปโพสเองบน Facebook — แค่เปลี่ยนสถานะ ไม่ยิงไปหา Facebook"
              >
                {busy === "markPosted" ? "..." : "📝 โพสเองแล้ว"}
              </button>
              <button
                onClick={() => patch({ status: "draft" }, "back")}
                disabled={busy !== null}
                className={`${btn} border border-gray-300 dark:border-gray-600`}
              >
                {busy === "back" ? "..." : "↩️ ย้อนเป็นร่าง"}
              </button>
            </>
          )}

          {article.status === "scheduled" && (
            <span className="self-center text-xs text-cyan-700 dark:text-cyan-300">
              🕐 กำหนดโพส {formatDate(article.scheduledAt)}
              {article.fbPostUrl && (
                <>
                  {" • "}
                  <a
                    href={article.fbPostUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    ดูโพสต์ที่ตั้งเวลาไว้
                  </a>
                </>
              )}
            </span>
          )}

          {article.status === "posted" && (
            <span className="self-center text-xs text-blue-700 dark:text-blue-300">
              {article.fbPostUrl ? "✅ โพสแล้วเมื่อ " : "📝 โพสเองแล้วเมื่อ "}
              {formatDate(article.postedAt)}
              {article.fbPostUrl && (
                <>
                  {" • "}
                  <a
                    href={article.fbPostUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    ดูโพสต์บน Facebook
                  </a>
                </>
              )}
            </span>
          )}

          {(article.status === "rejected" || article.status === "irrelevant") && (
            <button
              onClick={() => patch({ status: "draft" }, "restore")}
              disabled={busy !== null}
              className={`${btn} border border-gray-300 dark:border-gray-600`}
            >
              {busy === "restore" ? "..." : "↩️ กู้คืนเป็นร่าง"}
            </button>
          )}

          {(article.status === "draft" || article.status === "approved") && (
            <button
              onClick={longForm}
              disabled={busy !== null}
              className={`${btn} border border-violet-300 text-violet-600 hover:bg-violet-50 dark:border-violet-800 dark:hover:bg-violet-950`}
              title="ไปอ่านเนื้อข่าวจากเว็บสำนักข่าวจริง แล้วให้ AI เขียนแคปชันแบบยาว (เขียนทับแคปชันเดิม)"
            >
              {busy === "longForm" ? "✨ กำลังอ่านเว็บ..." : "✨ เขียนแคปชันยาว"}
            </button>
          )}

          {(article.status === "fetched" ||
            article.status === "rejected" ||
            article.status === "irrelevant") && (
            <button
              onClick={reprocess}
              disabled={busy !== null}
              className={`${btn} border border-indigo-300 text-indigo-600 hover:bg-indigo-50 dark:border-indigo-800 dark:hover:bg-indigo-950`}
            >
              {busy === "reprocess" ? "🤖 กำลังประมวลผล..." : "🤖 ให้ AI ประมวลผลใหม่"}
            </button>
          )}

          <button
            onClick={remove}
            disabled={busy !== null}
            className={`${btn} ml-auto border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950`}
            title="ลบข่าวนี้ออกจากรายการ (ไม่แตะโพสต์บน Facebook)"
          >
            {busy === "delete" ? "..." : "🗑️ ลบ"}
          </button>
        </div>
      )}
    </li>
  );
}
