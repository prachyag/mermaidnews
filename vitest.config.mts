import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // tsconfigPaths ทำให้ import alias "@/..." ใช้ได้ในเทสเหมือนในแอป
  plugins: [tsconfigPaths()],
  test: {
    // ทดสอบ logic ฝั่งเซิร์ฟเวอร์ล้วน ไม่ได้ render React จึงไม่ต้องใช้ jsdom
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // ชี้ @/db ไปฐานข้อมูลเทส — ต้องตั้งก่อน import เพราะ src/db/index.ts อ่าน env ตอน import
    env: { DATABASE_URL: "file:./data/test.db" },
    // เทสหลายไฟล์ใช้ฐานข้อมูลไฟล์เดียวกัน — รันทีละไฟล์กันเขียนทับกัน
    fileParallelism: false,
  },
});
