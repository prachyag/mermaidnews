"use client";

import { useState } from "react";
import type { ManagedUserDTO } from "@/lib/admin";
import type { UserStatus } from "@/db/schema";

const STATUS_META: Record<UserStatus, { label: string; badge: string }> = {
  pending: {
    label: "รออนุมัติ",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  active: {
    label: "ใช้งานได้",
    badge: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  },
  revoked: {
    label: "เพิกถอนแล้ว",
    badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  },
};

/** แปลง Date -> ค่าสำหรับ <input type="datetime-local"> ซึ่งต้องเป็นเวลาท้องถิ่นไม่มีโซน */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatExpiry(iso: string | null): string {
  if (!iso) return "ไม่มีกำหนด";
  return new Date(iso).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export function UserTable({ initial, meId }: { initial: ManagedUserDTO[]; meId: number }) {
  const [rows, setRows] = useState(initial);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function upsert(user: ManagedUserDTO) {
    setRows((prev) => prev.map((r) => (r.id === user.id ? user : r)));
  }

  return (
    <>
      {note && (
        <p
          className={`mb-4 rounded-lg px-3 py-2 text-sm ${
            note.kind === "ok"
              ? "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300"
              : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
          }`}
        >
          {note.text}
        </p>
      )}
      <div className="space-y-3">
        {rows.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            isMe={user.id === meId}
            onUpdated={upsert}
            onNote={setNote}
          />
        ))}
      </div>
    </>
  );
}

function UserRow({
  user,
  isMe,
  onUpdated,
  onNote,
}: {
  user: ManagedUserDTO;
  isMe: boolean;
  onUpdated: (u: ManagedUserDTO) => void;
  onNote: (n: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const [expiry, setExpiry] = useState(toLocalInput(user.accessExpiresAt));
  const [newPassword, setNewPassword] = useState("");
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    onNote(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        onUpdated(data.user);
        setExpiry(toLocalInput(data.user.accessExpiresAt));
        onNote({ kind: "ok", text: okText });
      } else {
        onNote({ kind: "error", text: data.error ?? "ทำรายการไม่สำเร็จ" });
      }
    } catch {
      onNote({ kind: "error", text: "เชื่อมต่อไม่ได้" });
    } finally {
      setBusy(false);
    }
  }

  async function patchRole(role: "admin" | "user", okText: string) {
    setBusy(true);
    onNote(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (res.ok) {
        onUpdated(data.user);
        setExpiry(toLocalInput(data.user.accessExpiresAt));
        onNote({ kind: "ok", text: okText });
      } else {
        onNote({ kind: "error", text: data.error ?? "เปลี่ยนสิทธิ์ไม่สำเร็จ" });
      }
    } catch {
      onNote({ kind: "error", text: "เชื่อมต่อไม่ได้" });
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onNote(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewPassword("");
        setShowPasswordForm(false);
        onNote({ kind: "ok", text: `${user.username}: ${data.message}` });
      } else {
        onNote({ kind: "error", text: data.error ?? "ตั้งรหัสผ่านไม่สำเร็จ" });
      }
    } catch {
      onNote({ kind: "error", text: "เชื่อมต่อไม่ได้" });
    } finally {
      setBusy(false);
    }
  }

  const meta = STATUS_META[user.status];
  const expired = user.status === "active" && !user.usable;

  return (
    <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{user.username}</span>
        {user.role === "admin" && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
            ผู้ดูแลระบบ
          </span>
        )}
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.badge}`}>
          {meta.label}
        </span>
        {expired && (
          <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
            สิทธิ์หมดอายุแล้ว
          </span>
        )}
        <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
          {user.email ?? "ไม่มีอีเมล"}
        </span>
      </div>

      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        สิทธิ์ใช้งานถึง: {formatExpiry(user.accessExpiresAt)}
      </p>

      {user.role === "admin" ? (
        <div className="mt-3">
          {isMe ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              นี่คือบัญชีของคุณเอง — แก้ไขได้ที่หน้าตั้งค่าบัญชี (กันเผลอเพิกถอนสิทธิ์ตัวเองจนเข้าระบบไม่ได้)
            </p>
          ) : (
            <>
              <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                บัญชีผู้ดูแลระบบด้วยกันแก้สถานะ/รหัสผ่านไม่ได้ — ลดขั้นเป็นผู้ใช้ก่อนจึงจะจัดการได้
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    !confirm(
                      `ลดขั้น ${user.username} จากผู้ดูแลระบบเป็นผู้ใช้ทั่วไป? เขาจะเข้าหน้าจัดการผู้ใช้ไม่ได้อีก`,
                    )
                  ) {
                    return;
                  }
                  patchRole("user", `ลดขั้น ${user.username} เป็นผู้ใช้แล้ว`);
                }}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
              >
                ⬇️ ลดขั้นเป็นผู้ใช้ทั่วไป
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {user.status !== "active" && (
              <button
                disabled={busy}
                onClick={() => patch({ status: "active" }, `อนุมัติ ${user.username} แล้ว`)}
                className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50"
              >
                ✅ อนุมัติให้ใช้งาน
              </button>
            )}
            {user.status !== "revoked" && (
              <button
                disabled={busy}
                onClick={() => {
                  if (!confirm(`เพิกถอนสิทธิ์ของ ${user.username}? เขาจะถูกให้ออกจากระบบทันที`)) {
                    return;
                  }
                  patch({ status: "revoked" }, `เพิกถอนสิทธิ์ ${user.username} แล้ว`);
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              >
                ⛔ เพิกถอนสิทธิ์
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => setShowPasswordForm((v) => !v)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-800"
            >
              🔑 ตั้งรหัสผ่านใหม่
            </button>
            <button
              disabled={busy}
              onClick={() => {
                if (
                  !confirm(
                    `ตั้ง ${user.username} เป็นผู้ดูแลระบบ? เขาจะจัดการผู้ใช้คนอื่นได้ทั้งหมด และบัญชีจะใช้งานได้ทันที`,
                  )
                ) {
                  return;
                }
                patchRole("admin", `ตั้ง ${user.username} เป็นผู้ดูแลระบบแล้ว`);
              }}
              className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
            >
              ⬆️ ตั้งเป็นผู้ดูแลระบบ
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                ใช้งานได้ถึง (เว้นว่าง = ไม่มีกำหนด)
              </label>
              <input
                type="datetime-local"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800"
              />
            </div>
            <button
              disabled={busy}
              onClick={() =>
                patch(
                  {
                    accessExpiresAt: expiry ? new Date(expiry).toISOString() : null,
                  },
                  `บันทึกเวลาใช้งานของ ${user.username} แล้ว`,
                )
              }
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              บันทึกเวลา
            </button>
          </div>

          {showPasswordForm && (
            <form onSubmit={savePassword} className="mt-3 flex flex-wrap items-end gap-2">
              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                  รหัสผ่านใหม่ของ {user.username} (อย่างน้อย 8 ตัวอักษร)
                </label>
                <input
                  type="text"
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="off"
                  className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900"
              >
                ตั้งรหัสผ่าน
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
