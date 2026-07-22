/**
 * Audit log ของผู้ดูแลระบบ — บันทึก (สำเร็จ/ถูกปฏิเสธ) + อ่านประวัติ + หมุนเวียนของเก่าทิ้ง
 *
 * แยกจาก admin.ts เพื่อเลี่ยง import วน และให้ตัวสร้างค่า (buildAuditValues) เป็นฟังก์ชันล้วน
 * ที่เทสได้โดยไม่แตะฐานข้อมูล การเขียน log ฝั่งสำเร็จทำในทรานแซกชันเดียวกับการแก้ข้อมูลจริง (ดู admin.ts)
 */
import { desc, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import {
  adminAuditLog,
  users,
  type AdminAction,
  type AuditOutcome,
  type NewAdminAuditEntry,
  type User,
} from "@/db/schema";

/**
 * จำนวนแถวสูงสุดที่เก็บไว้ — เกินกว่านี้แถวเก่าสุดจะถูกลบทิ้งอัตโนมัติหลังการเขียนแต่ละครั้ง
 * ใช้ || ไม่ใช่ ?? เพราะ env ที่ตั้งเป็นค่าว่างต้องถอยไปใช้ค่า default ไม่ใช่ 0 (= ลบทั้งหมด)
 */
export const AUDIT_LOG_MAX_ENTRIES = Number(process.env.AUDIT_LOG_MAX_ENTRIES) || 2000;

/** ประกอบค่าที่จะเขียนลง audit log จากผู้กระทำ/เป้าหมาย/การกระทำ — ล้วน ไม่แตะ DB */
export function buildAuditValues(input: {
  actor: Pick<User, "id" | "username">;
  target: Pick<User, "id" | "username">;
  action: AdminAction;
  summary: string;
  outcome?: AuditOutcome;
}): NewAdminAuditEntry {
  return {
    actorId: input.actor.id,
    actorUsername: input.actor.username,
    targetId: input.target.id,
    targetUsername: input.target.username,
    action: input.action,
    outcome: input.outcome ?? "success",
    summary: input.summary,
  };
}

/**
 * ลบแถวเก่าทิ้งให้เหลือไม่เกิน max — เก็บใหม่สุดไว้
 * เรียกหลังการเขียนทุกครั้ง (การกระทำ admin ความถี่ต่ำ ต้นทุน DELETE หนึ่งครั้งต่อการเขียนถือว่าคุ้ม
 * และยังกันตารางโตไม่จำกัดเมื่อมีความพยายามข้ามสิทธิ์รัว ๆ ที่ถูกบันทึกฝั่ง denied)
 */
export async function pruneAuditLog(max: number = AUDIT_LOG_MAX_ENTRIES): Promise<void> {
  const survivors = db
    .select({ id: adminAuditLog.id })
    .from(adminAuditLog)
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(max);
  await db.delete(adminAuditLog).where(notInArray(adminAuditLog.id, survivors));
}

/**
 * บันทึกความพยายามที่ถูกปฏิเสธเพราะไม่มีสิทธิ์ (เช่น คนที่ไม่ใช่ admin ยิง endpoint ของ admin,
 * หรือ admin พยายามแก้บัญชี admin อื่น) — ผู้กระทำต้องล็อกอินอยู่แล้ว (proxy กันคนนอกที่ 401 ก่อน)
 * จึงจำกัดวงอยู่แค่ "บัญชีจริงที่ทำเกินสิทธิ์" ไม่ใช่ทราฟฟิกภายนอกทั้งหมด
 */
export async function recordDenied(input: {
  actorId: number;
  targetId?: number | null;
  action: AdminAction;
  reason: string;
}): Promise<void> {
  const actor = await db.query.users.findFirst({ where: eq(users.id, input.actorId) });
  let targetUsername = "(ไม่ระบุ)";
  if (input.targetId != null) {
    const t = await db.query.users.findFirst({ where: eq(users.id, input.targetId) });
    if (t) targetUsername = t.username;
  }
  await db.insert(adminAuditLog).values({
    actorId: input.actorId,
    actorUsername: actor?.username ?? "(ไม่ทราบ)",
    targetId: input.targetId ?? null,
    targetUsername,
    action: input.action,
    outcome: "denied",
    summary: input.reason,
  });
  await pruneAuditLog();
}

export type AuditEntryDTO = {
  id: number;
  actorUsername: string;
  targetUsername: string;
  action: AdminAction;
  outcome: AuditOutcome;
  summary: string;
  createdAt: string;
};

/**
 * อ่านประวัติล่าสุด (เฉพาะผู้ดูแลระบบ) — ใหม่สุดก่อน
 * ตรวจสิทธิ์ที่นี่ด้วย ไม่ใช่แค่ใน route เพื่อให้หน้า server component เรียกตรงได้อย่างปลอดภัย
 */
export async function listAuditLog(
  actorId: number,
  { limit = 100 }: { limit?: number } = {},
): Promise<AuditEntryDTO[] | null> {
  const actor = await db.query.users.findFirst({ where: eq(users.id, actorId) });
  if (actor?.role !== "admin") return null; // null = ไม่มีสิทธิ์ (route แปลงเป็น 403)

  const rows = await db
    .select()
    .from(adminAuditLog)
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    actorUsername: r.actorUsername,
    targetUsername: r.targetUsername,
    action: r.action,
    outcome: r.outcome,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
  }));
}
