import { describe, expect, it } from "vitest";
import type { UserStatus } from "@/db/schema";
import { checkUserAccess } from "./user-access";

const NOW = new Date("2026-07-17T12:00:00Z");

describe("checkUserAccess", () => {
  it("active + ไม่มีวันหมดอายุ = ใช้ได้", () => {
    expect(checkUserAccess({ status: "active", accessExpiresAt: null }, NOW)).toEqual({
      usable: true,
    });
  });

  it("active + ยังไม่ถึงวันหมดอายุ = ใช้ได้", () => {
    const check = checkUserAccess(
      { status: "active", accessExpiresAt: new Date("2026-07-18T12:00:00Z") },
      NOW,
    );
    expect(check.usable).toBe(true);
  });

  it("pending = ใช้ไม่ได้ (สมัครไว้เฉย ๆ รออนุมัติ)", () => {
    const check = checkUserAccess({ status: "pending", accessExpiresAt: null }, NOW);
    expect(check).toMatchObject({ usable: false, reason: "pending" });
  });

  it("pending ที่ตั้งวันหมดอายุไว้ล่วงหน้า ก็ยังใช้ไม่ได้ — ต้องอนุมัติก่อนเสมอ", () => {
    const check = checkUserAccess(
      { status: "pending", accessExpiresAt: new Date("2027-01-01T00:00:00Z") },
      NOW,
    );
    expect(check).toMatchObject({ usable: false, reason: "pending" });
  });

  it("revoked = ใช้ไม่ได้ แม้วันหมดอายุยังไม่ถึง", () => {
    const check = checkUserAccess(
      { status: "revoked", accessExpiresAt: new Date("2030-01-01T00:00:00Z") },
      NOW,
    );
    expect(check).toMatchObject({ usable: false, reason: "revoked" });
  });

  it("active + เลยวันหมดอายุ = ใช้ไม่ได้", () => {
    const check = checkUserAccess(
      { status: "active", accessExpiresAt: new Date("2026-07-17T11:59:59Z") },
      NOW,
    );
    expect(check).toMatchObject({ usable: false, reason: "expired" });
  });

  it("หมดอายุพอดีวินาทีนั้น = ใช้ไม่ได้ (ขอบเขตนับแบบ inclusive)", () => {
    const check = checkUserAccess({ status: "active", accessExpiresAt: NOW }, NOW);
    expect(check).toMatchObject({ usable: false, reason: "expired" });
  });

  it("ใช้เวลาปัจจุบันจริงเมื่อไม่ส่ง now มา", () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    expect(checkUserAccess({ status: "active", accessExpiresAt: past }).usable).toBe(false);
    expect(checkUserAccess({ status: "active", accessExpiresAt: future }).usable).toBe(true);
  });

  it("สถานะที่ไม่รู้จัก = ใช้ไม่ได้ (fail closed ไม่ปล่อยผ่าน)", () => {
    const check = checkUserAccess(
      { status: "weird-value" as UserStatus, accessExpiresAt: null },
      NOW,
    );
    expect(check.usable).toBe(false);
  });

  it("ข้อความที่ส่งกลับต้องบอกสาเหตุให้ผู้ใช้เข้าใจ ไม่ใช่ error เปล่า", () => {
    for (const status of ["pending", "revoked"] as const) {
      const check = checkUserAccess({ status, accessExpiresAt: null }, NOW);
      if (check.usable) throw new Error("ต้องใช้ไม่ได้");
      expect(check.message.length).toBeGreaterThan(10);
    }
  });
});
