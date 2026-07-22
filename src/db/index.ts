import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "file:./data/dev.db";

// libSQL ไม่สร้างโฟลเดอร์ให้เอง — ถ้าเป็นไฟล์ local ต้องมีโฟลเดอร์ก่อน
if (url.startsWith("file:")) {
  const dir = path.dirname(url.slice("file:".length));
  fs.mkdirSync(dir, { recursive: true });
}

const client = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

export const db = drizzle(client, { schema });
