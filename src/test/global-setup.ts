import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * เตรียมฐานข้อมูลสำหรับเทส — ไฟล์แยกต่างหาก ไม่แตะ dev.db ของจริง
 *
 * ใช้ `drizzle-kit push` สร้างตารางจาก src/db/schema.ts โดยตรง แทนการเขียน
 * CREATE TABLE ไว้ในเทสเอง เพื่อไม่ให้ schema ของเทสเพี้ยนจาก schema จริง
 * เมื่อมีคนแก้ schema แล้วลืมแก้เทส (เทสจะพังทันทีถ้า schema ใช้ไม่ได้จริง)
 */
export const TEST_DB_PATH = "./data/test.db";
export const TEST_DB_URL = `file:${TEST_DB_PATH}`;

export default function setup() {
  fs.mkdirSync("./data", { recursive: true });
  // เริ่มจากฐานข้อมูลเปล่าทุกครั้ง — เทสต้องไม่ขึ้นกับผลของรอบก่อน
  fs.rmSync(TEST_DB_PATH, { force: true });

  // ต้อง "ลบ" DATABASE_AUTH_TOKEN ทิ้ง ไม่ใช่ส่งค่าว่าง — dialect turso ไม่ผ่าน
  // validation ถ้า authToken เป็นสตริงว่าง (ฐานข้อมูลไฟล์ local ไม่ต้องใช้ token)
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: TEST_DB_URL };
  delete env.DATABASE_AUTH_TOKEN;

  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    env,
    stdio: "pipe",
    shell: process.platform === "win32",
  });
}
