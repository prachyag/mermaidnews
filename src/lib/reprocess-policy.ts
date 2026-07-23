import type { ArticleStatus } from "@/db/schema";

/**
 * กติกาของการสั่งประมวลผลใหม่ — ไฟล์ล้วน ไม่ import ฐานข้อมูล
 *
 * ต้องแยกจาก bulk-reprocess.ts เพราะหน้าเว็บ (client component) ต้องใช้ค่าเหล่านี้ด้วย
 * ถ้า import จากไฟล์ที่แตะ db เข้าไป จะลาก node:fs เข้า client bundle แล้ว build พัง
 * (ใช้ `import type` กับ ArticleStatus เพราะ type ถูกลบตอนคอมไพล์ ไม่เหลือ runtime import)
 */

/**
 * สถานะที่สั่งประมวลผลใหม่ได้ — เฉพาะผลที่ AI สร้างเองเท่านั้น
 *
 * จงใจไม่รวม approved/scheduled/posted/rejected/failed เพราะทั้งหมดผ่าน "การตัดสินใจของคน" มาแล้ว
 * การให้ AI เขียนทับจะทำลายงานที่ผู้ใช้ตรวจ/แก้/อนุมัติไว้ (และ posted คือของที่ขึ้นเพจไปแล้ว)
 * ถ้าอยากทำกับข่าวพวกนั้นจริง ๆ ยังใช้ปุ่มประมวลผลใหม่รายชิ้นได้อยู่
 *
 * ไม่รวม "draft_long" ด้วยเหตุผลเดียวกันในเชิงต้นทุน: แต่ละชิ้นผ่านการโหลดหน้าเว็บจริง
 * + เรียก AI ด้วย prompt ยาวมาแล้ว การกดปุ่มเดียวแล้วเขียนทับด้วยแคปชันสั้นทั้งกอง
 * คือการทิ้งงานที่แพงที่สุดในระบบโดยไม่ได้ตั้งใจ (เพดานคือ 5 ชิ้น/ครั้ง กว่าจะสะสมได้)
 */
export const REPROCESSABLE: ArticleStatus[] = ["draft", "irrelevant"];

/**
 * เพดานต่อการกด 1 ครั้ง
 *
 * 100 ชิ้น = 20 ชุด (ชุดละ 5) ใช้เวลา AI รวม ~2–3 นาที ผ่านการวนเรียกหลาย request
 * มากกว่านี้เสี่ยงกินโควตา RPD ของ Gemini free tier หมดในการกดครั้งเดียว
 * และผู้ใช้ต้องนั่งรอนานเกินไปจนไม่รู้ว่าค้างหรือยัง — กดซ้ำได้ถ้ายังเหลือ
 */
export const MAX_REPROCESS = 100;

export function isReprocessable(value: unknown): value is ArticleStatus {
  return typeof value === "string" && REPROCESSABLE.includes(value as ArticleStatus);
}
