import { describe, expect, it } from "vitest";
import { normalizeTitle, normalizeUrl } from "@/lib/normalize";

/**
 * กติกาพวกนี้ถูกใช้ 2 ที่ที่ต้องตรงกันเป๊ะ: ตัวดึงข่าว (ตอนเทียบว่าข่าวซ้ำ/ถูกบล็อก)
 * และตอนลบข่าว (ตอนบันทึก key ลง blocked_articles)
 * ถ้าใครแก้ฟังก์ชันนี้โดยไม่คิด ข่าวที่บล็อกไว้เดิมจะเล็ดลอดกลับเข้ามาเงียบ ๆ
 * เพราะ key ที่เก็บไว้จะไม่ตรงกับ key ที่คำนวณใหม่ — เทสชุดนี้คือด่านกัน
 */

describe("normalizeUrl", () => {
  it("ตัด query string ออก (ลิงก์เดียวกันแต่มี tracking param = ข่าวเดียวกัน)", () => {
    expect(normalizeUrl("https://a.com/news?utm_source=fb")).toBe("https://a.com/news");
  });

  it("ตัด hash ออก", () => {
    expect(normalizeUrl("https://a.com/news#section2")).toBe("https://a.com/news");
  });

  it("ลิงก์เดียวกันที่มี param ต่างกัน ต้อง normalize ได้ค่าเท่ากัน", () => {
    expect(normalizeUrl("https://a.com/x?a=1")).toBe(normalizeUrl("https://a.com/x?b=2"));
  });

  it("คง path ไว้ ไม่ตัดทิ้ง", () => {
    expect(normalizeUrl("https://a.com/2026/07/mermaid-news")).toBe(
      "https://a.com/2026/07/mermaid-news",
    );
  });

  it("ลิงก์ที่ parse ไม่ได้ คืนค่าเดิมแบบ trim แล้ว (ไม่ throw)", () => {
    expect(normalizeUrl("  ไม่ใช่ url เลย  ")).toBe("ไม่ใช่ url เลย");
  });

  it("แยกแยะคนละ path ได้ (ต้องไม่รวบเป็นข่าวเดียวกัน)", () => {
    expect(normalizeUrl("https://a.com/x")).not.toBe(normalizeUrl("https://a.com/y"));
  });
});

describe("normalizeTitle", () => {
  it("ไม่สนตัวพิมพ์เล็กใหญ่", () => {
    expect(normalizeTitle("Mermaid Parade")).toBe(normalizeTitle("mermaid parade"));
  });

  it("ยุบช่องว่างซ้ำและตัดหัวท้าย", () => {
    expect(normalizeTitle("  Mermaid   Parade  ")).toBe("mermaid parade");
  });

  it("รวม tab/ขึ้นบรรทัดใหม่เป็นช่องว่างเดียว", () => {
    expect(normalizeTitle("Mermaid\n\tParade")).toBe("mermaid parade");
  });

  it("รองรับภาษาไทย", () => {
    expect(normalizeTitle("  พาเหรด  นางเงือก ")).toBe("พาเหรด นางเงือก");
  });

  it("หัวข้อคนละข่าวต้องไม่ชนกัน", () => {
    expect(normalizeTitle("นางเงือกที่ภูเก็ต")).not.toBe(normalizeTitle("นางเงือกที่กระบี่"));
  });
});
