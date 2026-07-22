"use client";

import { useState } from "react";
import type { AccountDTO } from "@/lib/account";

const INPUT =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800";
const CARD =
  "mb-4 rounded-xl border border-gray-200 p-5 dark:border-gray-700";

type Feedback = { kind: "ok" | "error"; text: string } | null;

function Note({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      className={`mt-3 text-sm ${feedback.kind === "ok" ? "text-green-600" : "text-red-600"}`}
    >
      {feedback.text}
    </p>
  );
}

export function AccountForms({ initial }: { initial: AccountDTO }) {
  return (
    <>
      <EmailForm initial={initial} />
      <PasswordForm />
    </>
  );
}

function EmailForm({ initial }: { initial: AccountDTO }) {
  const [email, setEmail] = useState(initial.email ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/email", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, currentPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setEmail(data.account?.email ?? email);
        setCurrentPassword("");
        setFeedback({ kind: "ok", text: "บันทึกอีเมลใหม่แล้ว" });
      } else {
        setFeedback({ kind: "error", text: data.error ?? "บันทึกไม่สำเร็จ" });
      }
    } catch {
      setFeedback({ kind: "error", text: "เชื่อมต่อไม่ได้" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={CARD}>
      <h2 className="mb-1 font-semibold">✉️ อีเมล</h2>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        {initial.email
          ? "ใช้เป็นช่องทางติดต่อของบัญชีนี้"
          : "บัญชีนี้ยังไม่มีอีเมล — เพิ่มไว้เพื่อใช้เป็นช่องทางติดต่อ"}
      </p>
      <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
        อีเมลใหม่
      </label>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoComplete="email"
        className={`mb-3 ${INPUT}`}
      />
      <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
        รหัสผ่านปัจจุบัน (ยืนยันว่าเป็นคุณ)
      </label>
      <input
        type="password"
        required
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        autoComplete="current-password"
        className={INPUT}
      />
      <button
        type="submit"
        disabled={busy}
        className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "กำลังบันทึก..." : "บันทึกอีเมล"}
      </button>
      <Note feedback={feedback} />
    </form>
  );
}

function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (newPassword !== confirm) {
      setFeedback({ kind: "error", text: "รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirm("");
        setFeedback({ kind: "ok", text: data.message ?? "เปลี่ยนรหัสผ่านแล้ว" });
      } else {
        setFeedback({ kind: "error", text: data.error ?? "เปลี่ยนรหัสผ่านไม่สำเร็จ" });
      }
    } catch {
      setFeedback({ kind: "error", text: "เชื่อมต่อไม่ได้" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={CARD}>
      <h2 className="mb-1 font-semibold">🔑 รหัสผ่าน</h2>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        เปลี่ยนแล้วอุปกรณ์อื่นที่ล็อกอินค้างไว้จะถูกให้ออกจากระบบทั้งหมด (เครื่องนี้ยังใช้ต่อได้)
      </p>
      <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
        รหัสผ่านปัจจุบัน
      </label>
      <input
        type="password"
        required
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        autoComplete="current-password"
        className={`mb-3 ${INPUT}`}
      />
      <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
        รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)
      </label>
      <input
        type="password"
        required
        minLength={8}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        autoComplete="new-password"
        className={`mb-3 ${INPUT}`}
      />
      <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
        ยืนยันรหัสผ่านใหม่
      </label>
      <input
        type="password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        className={INPUT}
      />
      <button
        type="submit"
        disabled={busy}
        className="mt-4 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
      >
        {busy ? "กำลังเปลี่ยน..." : "เปลี่ยนรหัสผ่าน"}
      </button>
      <Note feedback={feedback} />
    </form>
  );
}
