/**
 * ตรวจ/ทำให้อีเมลเป็นรูปแบบมาตรฐาน — แยกเป็นไฟล์ล้วน (ไม่ import db) เพื่อเทสได้โดยไม่เปิดฐานข้อมูล
 *
 * ขอบเขตที่ตั้งใจ: กัน "พิมพ์ผิด/ไม่ใช่อีเมล" เท่านั้น ไม่ได้พิสูจน์ว่าอีเมลมีอยู่จริง
 * (การพิสูจน์จริงต้องส่งลิงก์ยืนยัน ซึ่งยังไม่มีในระบบนี้ — ดู docs)
 * จงใจไม่ทำ regex ตาม RFC 5322 เป๊ะ เพราะยาวและปฏิเสธอีเมลจริงบ่อยกว่าที่ช่วย
 */

const EMAIL_RE = /^[^\s@,;:<>()[\]\\"]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** ความยาวสูงสุดตาม RFC 5321 (local 64 + @ + domain 255) — กัน payload ยาวผิดปกติ */
const MAX_LENGTH = 254;

/** ตัดช่องว่างหัวท้าย + ทำเป็นตัวพิมพ์เล็ก เพื่อให้เทียบซ้ำได้ตรงกันทุกที่ */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** true = มีรูปแบบเหมือนอีเมล (รับค่าที่ normalize แล้วหรือยังไม่ก็ได้) */
export function isValidEmail(value: string): boolean {
  const email = normalizeEmail(value);
  if (email.length === 0 || email.length > MAX_LENGTH) return false;
  const [local] = email.split("@");
  if (local.length > 64) return false;
  return EMAIL_RE.test(email);
}
