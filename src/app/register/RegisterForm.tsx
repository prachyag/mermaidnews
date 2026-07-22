"use client";

import Link from "next/link";
import { useState } from "react";

export function RegisterForm() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        // บัญชีแรกของระบบได้ใช้งานทันที ที่เหลือต้องรอ admin อนุมัติ — ยังไม่มี session ให้พาเข้าหน้าข่าว
        if (data.pending) {
          setPending(data.message ?? "สมัครสมาชิกแล้ว — รอผู้ดูแลระบบอนุมัติ");
          return;
        }
        window.location.href = "/";
        return;
      }
      setError(data.error ?? "สมัครไม่สำเร็จ");
    } catch {
      setError("เชื่อมต่อไม่ได้");
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <div className="w-full max-w-sm rounded-xl border border-gray-200 p-6 text-center dark:border-gray-700">
        <h1 className="mb-1 text-xl font-bold">📰 News Curator</h1>
        <p className="mb-1 text-2xl">⏳</p>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">{pending}</p>
        <Link
          href="/login"
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
        >
          ไปหน้าเข้าสู่ระบบ
        </Link>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-sm rounded-xl border border-gray-200 p-6 dark:border-gray-700"
    >
      <h1 className="mb-1 text-xl font-bold">📰 News Curator</h1>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">สมัครสมาชิกใหม่</p>
      <input
        required
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="ชื่อผู้ใช้ (a-z 0-9 _ . - อย่างน้อย 3 ตัว)"
        autoComplete="username"
        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
      />
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="อีเมล"
        autoComplete="email"
        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
      />
      <input
        type="password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)"
        autoComplete="new-password"
        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
      />
      <input
        type="password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="ยืนยันรหัสผ่าน"
        autoComplete="new-password"
        className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
      />
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
      >
        {busy ? "กำลังสมัคร..." : "สมัครสมาชิก"}
      </button>
      <p className="mt-4 text-center text-xs text-gray-500">
        มีบัญชีอยู่แล้ว?{" "}
        <Link href="/login" className="text-blue-600 underline">
          เข้าสู่ระบบ
        </Link>
      </p>
    </form>
  );
}
