import { describe, expect, it } from "vitest";
import {
  DEFAULT_FETCH_DAYS,
  FETCH_WINDOW_PRESETS,
  MAX_FETCH_DAYS,
  fetchWindowLabel,
  parseFetchDays,
} from "@/lib/fetch-window";

describe("parseFetchDays", () => {
  it("ไม่ระบุ = ใช้ค่าเริ่มต้น (ไม่ใช่ null — คำขอที่ไม่ส่ง days ต้องยังทำงานได้)", () => {
    expect(parseFetchDays(undefined)).toBe(DEFAULT_FETCH_DAYS);
    expect(parseFetchDays(null)).toBe(DEFAULT_FETCH_DAYS);
  });

  it.each([1, 7, 30])("รับค่าที่ถูกต้อง: %i", (days) => {
    expect(parseFetchDays(days)).toBe(days);
  });

  it("รับค่าที่เป็นสตริงตัวเลขจาก JSON ได้", () => {
    expect(parseFetchDays("14")).toBe(14);
  });

  /**
   * จงใจปฏิเสธแทนการ clamp เงียบ ๆ — ผู้ใช้ที่ขอ 365 วันแล้วได้ 30 โดยไม่มีใครบอก
   * จะสรุปว่าระบบดึงข่าวมาไม่ครบ ซึ่งไล่หาสาเหตุยากกว่า error ตรง ๆ มาก
   */
  it.each([0, -1, 31, 365, 1.5, NaN, "abc", "", true, {}, []])(
    "ปฏิเสธค่าที่ใช้ไม่ได้: %j",
    (bad) => {
      expect(parseFetchDays(bad)).toBeNull();
    },
  );

  it("เพดานคือ 30 วัน และค่าขอบพอดีต้องผ่าน", () => {
    expect(MAX_FETCH_DAYS).toBe(30);
    expect(parseFetchDays(MAX_FETCH_DAYS)).toBe(30);
    expect(parseFetchDays(MAX_FETCH_DAYS + 1)).toBeNull();
  });
});

describe("FETCH_WINDOW_PRESETS", () => {
  it("มี 3 ตัวเลือกตามที่ตกลง: 1 / 7 / 30 วัน", () => {
    expect(FETCH_WINDOW_PRESETS.map((p) => p.days)).toEqual([1, 7, 30]);
  });

  it("ทุกตัวเลือกต้องผ่าน validation ของฝั่งเซิร์ฟเวอร์", () => {
    // กันกรณีเพิ่ม preset ใหม่แล้วลืมว่ามันเกินเพดาน — หน้าเว็บจะมีปุ่มที่กดแล้วได้ 400
    for (const p of FETCH_WINDOW_PRESETS) {
      expect(parseFetchDays(p.days)).toBe(p.days);
    }
  });
});

describe("fetchWindowLabel", () => {
  it("1 วัน = วันนี้ (พูดแบบคนพูด ไม่ใช่ '1 วันย้อนหลัง')", () => {
    expect(fetchWindowLabel(1)).toBe("วันนี้");
  });

  it.each([
    [7, "7 วันย้อนหลัง"],
    [30, "30 วันย้อนหลัง"],
  ])("%i วัน = %s", (days, expected) => {
    expect(fetchWindowLabel(days)).toBe(expected);
  });
});
