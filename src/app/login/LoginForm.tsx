"use client";

import Link from "next/link";
import { useState } from "react";

export function LoginForm({ registrationOpen }: { registrationOpen: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const data = await res.json();
      setError(data.error ?? "ล็อกอินไม่สำเร็จ");
    } catch {
      setError("เชื่อมต่อไม่ได้");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-sm rounded-xl border border-gray-200 bg-white/70 backdrop-blur-sm dark:bg-gray-900/70 p-6 dark:border-gray-700"
    >
      <h1 className="mb-1 text-xl font-bold">PostMaid</h1>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        เข้าสู่ระบบเพื่อใช้งาน
      </p>
      <input
        required
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="ชื่อผู้ใช้"
        autoComplete="username"
        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
      />
      <input
        type="password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="รหัสผ่าน"
        autoComplete="current-password"
        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
      />
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "กำลังตรวจสอบ..." : "เข้าสู่ระบบ"}
      </button>
      {registrationOpen && (
        <p className="mt-4 text-center text-xs text-gray-500">
          ยังไม่มีบัญชี?{" "}
          <Link href="/register" className="text-blue-600 underline">
            สมัครสมาชิก
          </Link>
        </p>
      )}
    </form>
  );
}
