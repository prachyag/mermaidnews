import type { ArticleStatus } from "@/db/schema";

/**
 * นิยามกลางของสถานะข่าว — ป้ายไทย สี และลำดับ
 *
 * รวมไว้ที่เดียวเพราะเดิมป้าย/สีถูกก๊อปไว้ทั้งใน ArticleCard และหน้าแรก
 * พอเพิ่มสถานะใหม่ทีก็ลืมแก้อีกที่ (สถานะ "failed" เคยหลุดจากตัวกรองมาแล้ว)
 */

/**
 * ลำดับตามเส้นทางการทำงานจริง: ดึงเข้ามา -> AI ร่าง -> อนุมัติ -> ตั้งเวลา/โพส
 * แล้วค่อยตามด้วยสถานะปลายทางที่ไม่ได้ไปต่อ (ผิดพลาด/ปฏิเสธ/ไม่เกี่ยวข้อง)
 */
export const STATUS_ORDER: ArticleStatus[] = [
  "fetched",
  "draft",
  "approved",
  "scheduled",
  "posted",
  "failed",
  "rejected",
  "irrelevant",
];

export type StatusMeta = {
  /** ป้ายเต็ม — ใช้บนการ์ดข่าวและในข้อความยืนยัน ที่มีที่ให้อธิบาย */
  label: string;
  /** ป้ายสั้นสำหรับแท็บ — ป้ายเต็มทั้ง 9 อันรวมกันแล้วล้นจอเดสก์ท็อปจนต้องเลื่อนหา */
  short: string;
  /** สีป้ายบนการ์ดข่าว */
  badge: string;
  /** สีจุดนำหน้าชื่อแท็บ — ใช้สื่อสถานะโดยไม่ต้องพึ่งสีพื้นทั้งปุ่ม */
  dot: string;
};

export const STATUS_META: Record<ArticleStatus, StatusMeta> = {
  fetched: {
    label: "ใหม่ (รอ AI)",
    short: "ใหม่",
    badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    dot: "bg-slate-400",
  },
  draft: {
    label: "ร่างโพสต์",
    short: "ร่าง",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    dot: "bg-amber-500",
  },
  approved: {
    label: "อนุมัติแล้ว",
    short: "อนุมัติ",
    badge: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    dot: "bg-green-500",
  },
  scheduled: {
    label: "ตั้งเวลาแล้ว",
    short: "ตั้งเวลา",
    badge: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
    dot: "bg-cyan-500",
  },
  posted: {
    label: "โพสแล้ว",
    short: "โพสแล้ว",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    dot: "bg-blue-500",
  },
  failed: {
    label: "ผิดพลาด",
    short: "ผิดพลาด",
    badge: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
    dot: "bg-red-500",
  },
  rejected: {
    label: "ปฏิเสธ",
    short: "ปฏิเสธ",
    badge: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
    dot: "bg-rose-400",
  },
  irrelevant: {
    label: "ไม่เกี่ยวข้อง",
    short: "ไม่เกี่ยว",
    badge: "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-500",
    dot: "bg-gray-300 dark:bg-gray-600",
  },
};

export function statusLabel(status: string): string {
  return STATUS_META[status as ArticleStatus]?.label ?? status;
}

export function statusBadge(status: string): string {
  return STATUS_META[status as ArticleStatus]?.badge ?? STATUS_META.fetched.badge;
}
