/**
 * ส่วน token/crypto ที่ปลอดภัยต่อ edge/proxy (ใช้แค่ Web Crypto ไม่แตะฐานข้อมูล)
 * โครงสร้าง token: "<sessionId>.<userId>.<expUnixSec>.<hmacHex>"
 * - proxy ใช้ verifyTokenOptimistic() ตรวจแค่ HMAC + วันหมดอายุ (เร็ว ไม่ query DB)
 * - การเช็คว่า session ยังไม่ถูกเพิกถอน ทำใน session.ts (DAL) ที่แตะ DB ได้
 */
export const SESSION_COOKIE = "session";
const SESSION_DAYS = 30;
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;

/** คืน secret สำหรับเซ็น session — บน production ถ้าไม่ตั้ง AUTH_SECRET จะ throw (fail closed) */
function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET ต้องถูกตั้งค่าใน production — ระบบล็อกอินจะไม่ทำงานจนกว่าจะตั้ง",
    );
  }
  return "dev-secret-change-in-production";
}

async function hmacHex(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signSessionToken(
  sessionId: string,
  userId: number,
  expUnixSec: number,
): Promise<string> {
  const payload = `${sessionId}.${userId}.${expUnixSec}`;
  return `${payload}.${await hmacHex(payload)}`;
}

/** ตรวจ HMAC + วันหมดอายุ (ไม่แตะ DB) — คืนข้อมูลใน token ถ้าถูกต้อง */
export async function verifyTokenOptimistic(
  token: string,
): Promise<{ sessionId: string; userId: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [sessionId, userIdStr, expStr, sig] = parts;
  const payload = `${sessionId}.${userIdStr}.${expStr}`;
  if ((await hmacHex(payload)) !== sig) return null;
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const userId = Number(userIdStr);
  if (!Number.isInteger(userId)) return null;
  return { sessionId, userId };
}
