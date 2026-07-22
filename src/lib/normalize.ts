/**
 * กติกา normalize สำหรับ "ข่าวชิ้นเดียวกัน" — ใช้ร่วมกันระหว่างตัวดึงข่าว (fetcher)
 * และตัวบล็อกข่าวที่ถูกลบ (blocked_articles)
 *
 * สองที่นี้ต้องใช้กติกาเดียวกันเป๊ะ ไม่งั้นข่าวที่บล็อกไว้จะเล็ดลอดกลับเข้ามาได้
 * เพราะ key ที่บันทึกตอนลบ ไม่ตรงกับ key ที่ตัวดึงคำนวณตอนเทียบ
 */

/** ตัด query string และ hash ออก — ลิงก์เดียวกันแต่มี tracking param ต่างกัน = ข่าวเดียวกัน */
export function normalizeUrl(link: string): string {
  try {
    const u = new URL(link);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return link.trim();
  }
}

/** ใช้เทียบว่าเป็นข่าวเดียวกันไหมเมื่อมาจากคนละสำนัก (คนละ URL แต่พาดหัวเดียวกัน) */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}
