import { describe, expect, it } from "vitest";
import { buildFeedUrl, editionsFor, isThaiText } from "@/lib/editions";

describe("isThaiText", () => {
  it.each([
    ["นางเงือก", true],
    ["mermaid", false],
    ["mermaid นางเงือก", true], // มีไทยปนแม้แต่คำเดียวก็ถือว่าเป็นไทย
    ["", false],
    ["2026", false],
  ])("isThaiText(%j) = %s", (input, expected) => {
    expect(isThaiText(input)).toBe(expected);
  });
});

describe("editionsFor", () => {
  it("auto: keyword ไทย -> ฉบับไทย", () => {
    expect(editionsFor("นางเงือก", "auto")).toEqual(["th"]);
  });

  it("auto: keyword อังกฤษ -> ฉบับสหรัฐฯ", () => {
    expect(editionsFor("mermaid", "auto")).toEqual(["intl"]);
  });

  it("th: บังคับฉบับไทยแม้ keyword เป็นอังกฤษ", () => {
    expect(editionsFor("mermaid", "th")).toEqual(["th"]);
  });

  it("intl: บังคับฉบับสหรัฐฯ แม้ keyword เป็นไทย", () => {
    expect(editionsFor("นางเงือก", "intl")).toEqual(["intl"]);
  });

  it("both: ได้ทั้งสองฉบับ ไม่ว่า keyword ภาษาอะไร", () => {
    expect(editionsFor("mermaid", "both")).toEqual(["th", "intl"]);
    expect(editionsFor("นางเงือก", "both")).toEqual(["th", "intl"]);
  });

  it("ค่าที่ไม่รู้จัก ตกมาที่พฤติกรรมเดิม (auto) ไม่ throw", () => {
    // กันกรณีข้อมูลเก่าใน DB หรือค่าที่หลุด validation มา
    expect(editionsFor("นางเงือก", "ค่าเพี้ยน" as never)).toEqual(["th"]);
  });
});

describe("buildFeedUrl", () => {
  it("ใส่พารามิเตอร์ครบตามฉบับไทย", () => {
    const url = new URL(buildFeedUrl("นางเงือก", "th"));
    expect(url.origin + url.pathname).toBe("https://news.google.com/rss/search");
    expect(url.searchParams.get("q")).toBe("นางเงือก");
    expect(url.searchParams.get("hl")).toBe("th");
    expect(url.searchParams.get("gl")).toBe("TH");
    expect(url.searchParams.get("ceid")).toBe("TH:th");
  });

  it("ฉบับ intl ใช้ locale อังกฤษ", () => {
    const url = new URL(buildFeedUrl("mermaid", "intl"));
    expect(url.searchParams.get("hl")).toBe("en-US");
    expect(url.searchParams.get("ceid")).toBe("US:en");
  });

  it("escape keyword ที่มีอักขระพิเศษ (ต้องไม่ทำ URL พัง)", () => {
    const url = new URL(buildFeedUrl('mermaid & "parade" ?x=1', "intl"));
    expect(url.searchParams.get("q")).toBe('mermaid & "parade" ?x=1');
  });

  /**
   * ยืนยันกับ Google จริงแล้วว่า when:Nd ถูกเคารพตรงเป๊ะ
   * (ไม่กรอง = เก่าสุด 3,384 วัน / when:7d = เก่าสุด 7.0 วัน)
   */
  it("ระบุจำนวนวัน = แนบตัวกรอง when:Nd ไปในคำค้น", () => {
    const url = new URL(buildFeedUrl("นางเงือก", "th", 7));
    expect(url.searchParams.get("q")).toBe("นางเงือก when:7d");
  });

  it("ไม่ระบุจำนวนวัน = ไม่แนบตัวกรอง (พฤติกรรมเดิม)", () => {
    const url = new URL(buildFeedUrl("นางเงือก", "th"));
    expect(url.searchParams.get("q")).toBe("นางเงือก");
  });

  it("ตัวกรองเวลาต้องอยู่ในคำค้น ไม่ใช่พารามิเตอร์แยก (Google รับแบบนี้เท่านั้น)", () => {
    const url = new URL(buildFeedUrl("mermaid", "intl", 30));
    expect(url.searchParams.get("q")).toBe("mermaid when:30d");
    expect(url.searchParams.get("when")).toBeNull();
  });
});
