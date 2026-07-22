import type { NewsSource } from "@/db/schema";

/**
 * การเลือก "ฉบับ" (edition) ของ Google News ตามการตั้งค่าแหล่งข่าวของหัวข้อ
 *
 * แยกออกจาก fetcher.ts เพราะเป็น logic บริสุทธิ์ที่ไม่ต้องพึ่งฐานข้อมูล —
 * ทดสอบได้โดยไม่ต้องเปิด DB หรือยิงเน็ต
 */

/** ฉบับของ Google News — ตัวกำหนดว่าจะได้ข่าวจากสำนักไหนเป็นหลัก */
export const EDITIONS = {
  th: { hl: "th", gl: "TH", ceid: "TH:th" },
  intl: { hl: "en-US", gl: "US", ceid: "US:en" },
} as const;

export type EditionKey = keyof typeof EDITIONS;

export function isThaiText(text: string): boolean {
  return /[฀-๿]/.test(text);
}

/**
 * คืนรายการฉบับที่ต้องดึงสำหรับ keyword หนึ่ง ตามการตั้งค่าของหัวข้อ
 *
 * หมายเหตุ: การเลือกฉบับ "ใกล้เคียง" การเลือกสัญชาติสำนักข่าว แต่ไม่ตรงเป๊ะ —
 * Google News ไม่มีตัวกรองสัญชาติสำนักข่าวให้ใช้ ฉบับไทยส่วนใหญ่คืนสำนักไทย
 * แต่ก็อาจมีสำนักต่างชาติที่รายงานข่าวไทยปนมาได้ (ยืนยันด้วยการยิงจริงแล้ว)
 */
export function editionsFor(keyword: string, source: NewsSource): EditionKey[] {
  switch (source) {
    case "th":
      return ["th"];
    case "intl":
      return ["intl"];
    case "both":
      return ["th", "intl"];
    case "auto":
    default:
      return [isThaiText(keyword) ? "th" : "intl"];
  }
}

export function buildFeedUrl(keyword: string, edition: EditionKey): string {
  const params = new URLSearchParams({ q: keyword, ...EDITIONS[edition] });
  return `https://news.google.com/rss/search?${params.toString()}`;
}
