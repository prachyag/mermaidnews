/**
 * กติกา "บัญชีนี้ใช้งานระบบได้ไหม" — ไฟล์ล้วน (ไม่ import db) เพื่อเทสได้โดยไม่เปิดฐานข้อมูล
 *
 * ทำไมต้องรวมไว้ที่เดียว: กติกานี้ถูกบังคับ 2 จุด (ตอนล็อกอิน และตอนตรวจ session ทุก request)
 * ถ้าเขียนแยกกันสองที่ วันหนึ่งมันจะไม่ตรงกัน แล้วจะได้ช่องที่บัญชีถูกเพิกถอนแล้วยังใช้งานต่อได้
 */
import type { UserStatus } from "@/db/schema";

export type AccessSubject = {
  status: UserStatus;
  accessExpiresAt: Date | null;
};

export type AccessCheck =
  | { usable: true }
  | { usable: false; reason: "pending" | "revoked" | "expired"; message: string };

/**
 * ตรวจว่าบัญชีใช้งานได้ ณ เวลา now
 * fail closed: สถานะที่ไม่รู้จัก (เช่นข้อมูลเพี้ยน) ถือว่าใช้ไม่ได้ ไม่ใช่ปล่อยผ่าน
 */
export function checkUserAccess(user: AccessSubject, now: Date = new Date()): AccessCheck {
  if (user.status === "pending") {
    return {
      usable: false,
      reason: "pending",
      message: "บัญชีนี้รอผู้ดูแลระบบอนุมัติก่อนจึงจะใช้งานได้",
    };
  }
  if (user.status !== "active") {
    return {
      usable: false,
      reason: "revoked",
      message: "บัญชีนี้ถูกเพิกถอนสิทธิ์ใช้งาน — ติดต่อผู้ดูแลระบบ",
    };
  }
  if (user.accessExpiresAt !== null && user.accessExpiresAt.getTime() <= now.getTime()) {
    return {
      usable: false,
      reason: "expired",
      message: "สิทธิ์ใช้งานของบัญชีนี้หมดอายุแล้ว — ติดต่อผู้ดูแลระบบ",
    };
  }
  return { usable: true };
}
