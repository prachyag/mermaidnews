"use client";

import { NEWS_SOURCES, NEWS_SOURCE_LABELS } from "@/lib/news-source";
import { useCallback, useEffect, useState } from "react";

import type { NewsSource } from "@/db/schema";

type Topic = {
  id: number;
  name: string;
  keywords: string[];
  aiContext: string | null;
  captionStyle: string | null;
  newsSource: NewsSource;
  fbPageId: string | null;
  hasFbToken: boolean;
  cronSchedule: string;
  enabled: boolean;
};

type BlockedRow = { id: number; title: string; url: string; createdAt: string };

type DiagnosisCheck = { label: string; status: "ok" | "fail"; detail: string };
type Diagnosis = { ok: boolean; summary: string; checks: DiagnosisCheck[] };

type TopicForm = {
  name: string;
  keywords: string;
  aiContext: string;
  captionStyle: string;
  newsSource: NewsSource;
  fbPageId: string;
  /** ค่าที่พิมพ์ใหม่เท่านั้น — เว้นว่าง = คง token เดิม (client ไม่เคยได้ token กลับมา) */
  fbPageToken: string;
};

const EMPTY_FORM: TopicForm = {
  name: "",
  keywords: "",
  aiContext: "",
  captionStyle: "",
  newsSource: "auto",
  fbPageId: "",
  fbPageToken: "",
};

function toForm(t: Topic): TopicForm {
  return {
    name: t.name,
    keywords: t.keywords.join(", "),
    aiContext: t.aiContext ?? "",
    captionStyle: t.captionStyle ?? "",
    newsSource: t.newsSource ?? "auto",
    fbPageId: t.fbPageId ?? "",
    fbPageToken: "",
  };
}

function toBody(form: TopicForm) {
  return {
    name: form.name,
    keywords: form.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    aiContext: form.aiContext,
    captionStyle: form.captionStyle,
    newsSource: form.newsSource,
    fbPageId: form.fbPageId,
    // ส่ง token เฉพาะเมื่อพิมพ์ค่าใหม่ ไม่งั้นไม่แตะ (กันเผลอล้างของเดิม)
    ...(form.fbPageToken.trim()
      ? { fbPageToken: form.fbPageToken.trim() }
      : {}),
  };
}

export default function TopicsPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [editingId, setEditingId] = useState<number | "new" | null>(null);
  const [form, setForm] = useState<TopicForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [diagnoses, setDiagnoses] = useState<Record<number, Diagnosis>>({});
  const [blockedFor, setBlockedFor] = useState<number | null>(null);
  const [blockedRows, setBlockedRows] = useState<BlockedRow[]>([]);

  const load = useCallback(async () => {
    const res = await fetch("/api/topics");
    const data = await res.json();
    setTopics(data.topics ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const isNew = editingId === "new";
      const res = await fetch(
        isNew ? "/api/topics" : `/api/topics/${editingId}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toBody(form)),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "บันทึกไม่สำเร็จ");
        return;
      }
      // ผลทดสอบเดิมใช้ไม่ได้แล้วถ้าเพิ่งแก้ Page ID/token — ล้างทิ้งกันเข้าใจผิด
      if (typeof editingId === "number") {
        setDiagnoses((prev) => {
          const next = { ...prev };
          delete next[editingId];
          return next;
        });
      }
      setEditingId(null);
      setForm(EMPTY_FORM);
      setMessage(isNew ? "สร้างหัวข้อแล้ว" : "บันทึกแล้ว");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(t: Topic) {
    setTestingId(t.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/topics/${t.id}/test-connection`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "ทดสอบไม่สำเร็จ");
        return;
      }
      setDiagnoses((prev) => ({ ...prev, [t.id]: data.diagnosis }));
    } finally {
      setTestingId(null);
    }
  }

  async function showBlocked(t: Topic) {
    if (blockedFor === t.id) {
      setBlockedFor(null);
      return;
    }
    setMessage(null);
    const res = await fetch(`/api/topics/${t.id}/blocked`);
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error ?? "ดูรายการที่บล็อกไม่สำเร็จ");
      return;
    }
    setBlockedRows(data.blocked ?? []);
    setBlockedFor(t.id);
  }

  async function unblock(topicId: number, blockedId?: number) {
    if (
      blockedId === undefined &&
      !window.confirm(
        "เลิกบล็อกทั้งหมด?\n\nข่าวที่เคยลบไปจะกลับเข้ามาใหม่ในรอบดึงถัดไป ถ้ายังอยู่ในฟีด RSS",
      )
    ) {
      return;
    }
    const res = await fetch(`/api/topics/${topicId}/blocked`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(blockedId !== undefined ? { blockedId } : {}),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error ?? "เลิกบล็อกไม่สำเร็จ");
      return;
    }
    setMessage(
      `เลิกบล็อก ${data.removed} รายการแล้ว — จะกลับมาในรอบดึงถัดไปถ้ายังอยู่ในฟีด`,
    );
    setBlockedRows((prev) =>
      blockedId !== undefined ? prev.filter((b) => b.id !== blockedId) : [],
    );
  }

  async function toggleEnabled(t: Topic) {
    await fetch(`/api/topics/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !t.enabled }),
    });
    await load();
  }

  async function remove(t: Topic) {
    const first = window.confirm(
      `ลบหัวข้อ "${t.name}"?\n\n⚠️ ข่าวและประวัติทั้งหมดใต้หัวข้อนี้จะถูกลบไปด้วย และกู้คืนไม่ได้`,
    );
    if (!first) return;
    const second = window.confirm(`ยืนยันอีกครั้ง: ลบ "${t.name}" ถาวร?`);
    if (!second) return;
    const res = await fetch(`/api/topics/${t.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      setMessage(data.error ?? "ลบไม่สำเร็จ");
      return;
    }
    setMessage(`ลบหัวข้อ "${t.name}" แล้ว`);
    await load();
  }

  const inputCls =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800";

  function renderForm() {
    const editingTokenSet =
      typeof editingId === "number" &&
      (topics.find((t) => t.id === editingId)?.hasFbToken ?? false);
    return (
      <div className="mt-3 space-y-3">
        <div>
          <label className="mb-1 block text-xs text-gray-500">ชื่อหัวข้อ</label>
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
            placeholder="เช่น นางเงือก"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            Keywords (คั่นด้วยจุลภาค ไทย/อังกฤษได้)
          </label>
          <input
            value={form.keywords}
            onChange={(e) => setForm({ ...form, keywords: e.target.value })}
            className={inputCls}
            placeholder="เช่น นางเงือก, mermaid"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">แหล่งข่าว</label>
          <select
            value={form.newsSource}
            onChange={(e) =>
              setForm({ ...form, newsSource: e.target.value as NewsSource })
            }
            className={inputCls}
          >
            {NEWS_SOURCES.map((s) => (
              <option key={s} value={s}>
                {NEWS_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-400">
            เลือกฉบับของ Google News ที่จะดึง — ฉบับไทยส่วนใหญ่ให้สำนักข่าวไทย
            ฉบับอังกฤษให้สำนักต่างประเทศ แต่ Google
            ไม่มีตัวกรองสัญชาติสำนักข่าวตรง ๆ จึงอาจมีปนกันได้บ้าง
            {form.newsSource === "th" &&
              " • ถ้า keyword เป็นภาษาอังกฤษล้วน ฉบับไทยอาจหาข่าวได้น้อย"}
            {form.newsSource === "intl" &&
              " • ถ้า keyword เป็นภาษาไทย ฉบับอังกฤษอาจหาข่าวแทบไม่ได้เลย"}
            {form.newsSource === "both" &&
              " • ดึง 2 ฉบับต่อ keyword ใช้เวลานานขึ้นเท่าตัว"}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            บริบทสำหรับ AI — ข่าวแบบไหน &quot;เกี่ยวข้อง&quot; กับหัวข้อนี้
          </label>
          <textarea
            value={form.aiContext}
            onChange={(e) => setForm({ ...form, aiContext: e.target.value })}
            rows={3}
            className={inputCls}
            placeholder="เช่น ข่าวเกี่ยวกับนางเงือกทุกแง่มุม — ไม่รวมข่าวที่แค่ชื่อสถานที่บังเอิญมีคำนี้"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            สไตล์แคปชัน
          </label>
          <textarea
            value={form.captionStyle}
            onChange={(e) => setForm({ ...form, captionStyle: e.target.value })}
            rows={2}
            className={inputCls}
            placeholder="เช่น เป็นกันเอง อ่านง่าย มีอีโมจิพองาม"
          />
        </div>
        <div>
          <div className="mb-4 rounded-xl">
            <h2 className="font-semibold">โพสเฟสบุกอัตโนมัติ</h2>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            Facebook Page ID (เพจปลายทางของหัวข้อนี้ — ดูวิธีหาได้ใน
            docs/FACEBOOK_SETUP.md)
          </label>
          <input
            value={form.fbPageId}
            onChange={(e) => setForm({ ...form, fbPageId: e.target.value })}
            className={inputCls}
            placeholder="เช่น 123456789012345"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">
            Facebook Page Access Token (secret ต่อหัวข้อ — ดูวิธีขอใน
            docs/FACEBOOK_SETUP.md)
          </label>
          <input
            type="password"
            value={form.fbPageToken}
            onChange={(e) => setForm({ ...form, fbPageToken: e.target.value })}
            className={inputCls}
            autoComplete="off"
            placeholder={
              editingTokenSet
                ? "ตั้งไว้แล้ว • พิมพ์ค่าใหม่เพื่อเปลี่ยน (เว้นว่าง = คงเดิม)"
                : "วาง Page Access Token"
            }
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "กำลังบันทึก..." : "บันทึก"}
          </button>
          <button
            onClick={() => {
              setEditingId(null);
              setForm(EMPTY_FORM);
            }}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-600"
          >
            ยกเลิก
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">⚙️ จัดการหัวข้อ</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            สร้าง แก้ไข เปิด-ปิด หรือลบหัวข้อข่าวที่ติดตาม
          </p>
        </div>
        {editingId === null && (
          <button
            onClick={() => {
              setEditingId("new");
              setForm(EMPTY_FORM);
            }}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            ➕ เพิ่มหัวข้อ
          </button>
        )}
      </header>

      {message && (
        <p className="mb-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {message}
        </p>
      )}

      {editingId === "new" && (
        <div className="mb-4 rounded-xl border border-blue-300 p-4 bg-white/70 backdrop-blur-sm dark:bg-gray-900/70 dark:border-blue-700">
          <h2 className="font-semibold">หัวข้อใหม่</h2>
          {renderForm()}
        </div>
      )}

      <ul className="space-y-3">
        {topics.map((t) => (
          <li
            key={t.id}
            className={`rounded-xl border p-4 bg-white/70 backdrop-blur-sm dark:bg-gray-900/70 ${t.enabled ? "border-gray-200 dark:border-gray-700" : "border-dashed border-gray-300 opacity-60 dark:border-gray-600"}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-semibold">{t.name}</span>
                {!t.enabled && (
                  <span className="ml-2 text-xs text-gray-400">
                    (ปิดใช้งาน)
                  </span>
                )}
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  keywords: {t.keywords.join(", ")}
                </p>
              </div>
              {editingId !== t.id && (
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      setEditingId(t.id);
                      setForm(toForm(t));
                    }}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600"
                  >
                    ✏️ แก้ไข
                  </button>
                  <button
                    onClick={() => testConnection(t)}
                    disabled={testingId === t.id}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs disabled:opacity-50 dark:border-gray-600"
                    title="ตรวจว่า Page ID และ token พร้อมโพสจริงไหม (ไม่โพสอะไรทั้งสิ้น)"
                  >
                    {testingId === t.id
                      ? "⏳ กำลังตรวจ..."
                      : "🔌 ทดสอบการเชื่อมต่อ"}
                  </button>
                  <button
                    onClick={() => showBlocked(t)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600"
                    title="ข่าวที่ลบไปแล้วและถูกกันไม่ให้ดึงกลับมา — เลิกบล็อกได้ที่นี่"
                  >
                    🚫 รายการที่บล็อกไว้
                  </button>
                  <button
                    onClick={() => toggleEnabled(t)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-600"
                  >
                    {t.enabled ? "⏸️ ปิดใช้งาน" : "▶️ เปิดใช้งาน"}
                  </button>
                  <button
                    onClick={() => remove(t)}
                    className="rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950"
                  >
                    🗑️ ลบ
                  </button>
                </div>
              )}
            </div>
            {editingId === t.id && renderForm()}
            {editingId !== t.id && (
              <div className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
                <p>
                  🌏 แหล่งข่าว: {NEWS_SOURCE_LABELS[t.newsSource ?? "auto"]}
                </p>
                {t.aiContext && <p>🎯 บริบท AI: {t.aiContext}</p>}
                {t.captionStyle && <p>✏️ สไตล์แคปชัน: {t.captionStyle}</p>}
                {t.fbPageId ? (
                  <p>📘 Facebook Page ID: {t.fbPageId}</p>
                ) : (
                  <p className="text-amber-600 dark:text-amber-400">
                    📘 ยังไม่ได้ตั้ง Facebook Page ID — ไม่สามารถโพสอัตโนมัติได้
                  </p>
                )}
                {t.hasFbToken ? (
                  <p>🔑 Access Token: ตั้งไว้แล้ว</p>
                ) : (
                  <p className="text-amber-600 dark:text-amber-400">
                    🔑 ยังไม่ได้ตั้ง Access Token — ไม่สามารถโพสอัตโนมัติได้
                  </p>
                )}
              </div>
            )}
            {blockedFor === t.id && (
              <div className="mt-3 rounded-lg border border-gray-200 p-3 text-xs dark:border-gray-700">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="font-semibold">
                    🚫 ข่าวที่บล็อกไว้ ({blockedRows.length} รายการ)
                  </p>
                  {blockedRows.length > 0 && (
                    <button
                      onClick={() => unblock(t.id)}
                      className="rounded-lg border border-gray-300 px-2 py-1 dark:border-gray-600"
                    >
                      เลิกบล็อกทั้งหมด
                    </button>
                  )}
                </div>
                {blockedRows.length === 0 ? (
                  <p className="text-gray-500 dark:text-gray-400">
                    ยังไม่มีข่าวที่ถูกบล็อก — ข่าวที่คุณกดลบจะมาอยู่ที่นี่
                    และจะไม่ถูกดึงกลับมาอีก
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {blockedRows.map((b) => (
                      <li
                        key={b.id}
                        className="flex items-start justify-between gap-2"
                      >
                        <a
                          href={b.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-600 hover:underline dark:text-gray-300"
                        >
                          {b.title}
                        </a>
                        <button
                          onClick={() => unblock(t.id, b.id)}
                          className="shrink-0 rounded-lg border border-gray-300 px-2 py-0.5 dark:border-gray-600"
                          title="เลิกบล็อกข่าวนี้ — จะกลับมาในรอบดึงถัดไปถ้ายังอยู่ในฟีด"
                        >
                          ↩️ เลิกบล็อก
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {diagnoses[t.id] && (
              <div
                className={`mt-3 rounded-lg border p-3 text-xs ${
                  diagnoses[t.id].ok
                    ? "border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950"
                    : "border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold">
                    {diagnoses[t.id].ok ? "✅" : "❌"} {diagnoses[t.id].summary}
                  </p>
                  <button
                    onClick={() =>
                      setDiagnoses((prev) => {
                        const next = { ...prev };
                        delete next[t.id];
                        return next;
                      })
                    }
                    className="text-gray-400 hover:text-gray-600"
                    aria-label="ปิดผลทดสอบ"
                  >
                    ✕
                  </button>
                </div>
                <ul className="mt-2 space-y-1.5">
                  {diagnoses[t.id].checks.map((c, i) => (
                    <li key={i}>
                      <span className="font-medium">
                        {c.status === "ok" ? "✅" : "❌"} {c.label}:
                      </span>{" "}
                      <span className="text-gray-600 dark:text-gray-300">
                        {c.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
