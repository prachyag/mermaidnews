import { describe, expect, it } from "vitest";
import { isValidEmail, normalizeEmail } from "./email";

describe("normalizeEmail", () => {
  it("ตัดช่องว่างหัวท้าย", () => {
    expect(normalizeEmail("  a@b.com  ")).toBe("a@b.com");
  });

  it("ทำเป็นตัวพิมพ์เล็ก — กันสมัครซ้ำด้วยตัวพิมพ์ต่างกัน", () => {
    expect(normalizeEmail("Prachya.G@Gmail.COM")).toBe("prachya.g@gmail.com");
  });

  it("ค่าที่ normalize แล้ว normalize ซ้ำได้ผลเดิม (idempotent)", () => {
    const once = normalizeEmail(" Foo@Bar.io ");
    expect(normalizeEmail(once)).toBe(once);
  });
});

describe("isValidEmail", () => {
  it.each([
    "a@b.co",
    "prachya.g@gmail.com",
    "user+tag@example.co.th",
    "first_last@sub.domain.org",
    "user-name@my-host.net",
    "  Spaced@Example.COM  ", // normalize ก่อนตรวจ
  ])("ผ่าน: %s", (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each<[string, string]>([
    ["", "ค่าว่าง"],
    ["   ", "ช่องว่างล้วน"],
    ["notanemail", "ไม่มี @"],
    ["@example.com", "ไม่มีชื่อหน้า @"],
    ["user@", "ไม่มีโดเมน"],
    ["user@localhost", "โดเมนไม่มีจุด"],
    ["user@.com", "โดเมนขึ้นต้นด้วยจุด"],
    ["user@example.", "โดเมนลงท้ายด้วยจุด"],
    ["user@@example.com", "@ ซ้อน"],
    ["a b@example.com", "มีช่องว่างกลางอีเมล"],
    ["user<script>@example.com", "อักขระ HTML"],
    ["a@b.com, c@d.com", "ใส่มาหลายอีเมลคั่นด้วย comma"],
    ["a@b.com;c@d.com", "คั่นด้วย semicolon"],
    ["<a@b.com>", "รูปแบบ header ที่มีวงเล็บ"],
  ])("ไม่ผ่าน: %s (%s)", (value) => {
    expect(isValidEmail(value)).toBe(false);
  });

  it("ไม่ผ่านถ้าชื่อหน้า @ ยาวเกิน 64 ตัว", () => {
    expect(isValidEmail(`${"a".repeat(64)}@example.com`)).toBe(true);
    expect(isValidEmail(`${"a".repeat(65)}@example.com`)).toBe(false);
  });

  it("ไม่ผ่านถ้ายาวเกิน 254 ตัว — กัน payload ยาวผิดปกติ", () => {
    const domain = `${"d".repeat(240)}.com`;
    expect(isValidEmail(`abc@${domain}`).valueOf()).toBe(true);
    expect(isValidEmail(`${"a".repeat(60)}@${domain}`)).toBe(false);
  });
});
