import { describe, expect, it } from "vitest";
import { NEWS_SOURCES, NEWS_SOURCE_LABELS, parseNewsSource } from "@/lib/news-source";

describe("parseNewsSource", () => {
  it.each(NEWS_SOURCES)("รับค่าที่ถูกต้อง: %s", (s) => {
    expect(parseNewsSource(s)).toBe(s);
  });

  it.each<[unknown, string]>([
    ["ค่ามั่ว", "สตริงที่ไม่อยู่ในรายการ"],
    ["", "สตริงว่าง"],
    [null, "null"],
    [undefined, "undefined"],
    [1, "ตัวเลข"],
    [["th"], "อาร์เรย์"],
    [{ newsSource: "th" }, "อ็อบเจกต์"],
    ["TH", "ตัวพิมพ์ใหญ่ (ต้องไม่รับ เพราะค่าที่เก็บใน DB เป็นตัวเล็ก)"],
  ])("ปฏิเสธค่าที่ผิด: %j (%s)", (input) => {
    expect(parseNewsSource(input)).toBeNull();
  });
});

describe("NEWS_SOURCE_LABELS", () => {
  it("มีป้ายภาษาไทยครบทุกค่าที่รองรับ (กัน UI แสดง undefined)", () => {
    for (const s of NEWS_SOURCES) {
      expect(NEWS_SOURCE_LABELS[s]).toBeTruthy();
    }
  });
});
