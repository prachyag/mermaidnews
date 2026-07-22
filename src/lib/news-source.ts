import type { NewsSource } from "@/db/schema";

/** ค่าที่ยอมรับได้ของ topics.newsSource — จุดเดียวที่นิยามไว้ ใช้ทั้ง API และ UI */
export const NEWS_SOURCES: NewsSource[] = ["auto", "th", "intl", "both"];

export const NEWS_SOURCE_LABELS: Record<NewsSource, string> = {
  auto: "อัตโนมัติ (เดาจากภาษาของ keyword)",
  th: "สำนักข่าวไทยเท่านั้น",
  intl: "ต่างประเทศเท่านั้น (อังกฤษ)",
  both: "ทั้งไทยและต่างประเทศ",
};

/** คืนค่าที่ถูกต้อง หรือ null ถ้าค่าที่ส่งมาไม่อยู่ในรายการ (ให้ route ตอบ 400) */
export function parseNewsSource(value: unknown): NewsSource | null {
  return NEWS_SOURCES.includes(value as NewsSource) ? (value as NewsSource) : null;
}
