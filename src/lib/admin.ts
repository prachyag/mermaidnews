/**
 * Data Access Layer ของผู้ดูแลระบบ (super admin) — จัดการบัญชีคนอื่น
 *
 * กติกาที่บังคับในชั้นนี้ (ไม่ใช่ใน route) เพื่อให้เทสครอบและไม่หลุดเวลาเพิ่ม endpoint ใหม่:
 * 1. เฉพาะ role "admin" เท่านั้นที่ทำได้ — ตรวจจาก DB ทุกครั้ง ไม่เชื่อค่าที่ client ส่งมา
 * 2. แก้ไขบัญชีที่เป็น admin ไม่ได้ (รวมถึงตัวเอง) — กันเผลอเพิกถอน/ตั้งวันหมดอายุให้ผู้ดูแล
 *    แล้วล็อกผู้ดูแลออกจากระบบถาวรโดยไม่มีใครเหลือกู้คืนให้ ถ้ามี admin หลายคนก็กันแย่งกัน
 *    เพิกถอน/ยึดบัญชีกันเองด้วย เปลี่ยนรหัสผ่านตัวเองใช้ /account
 * 3. เปลี่ยนสถานะเป็นใช้ไม่ได้ หรือแก้รหัสผ่านให้ใคร = เพิกถอน session ของคนนั้นทันที
 *    ไม่งั้น "เพิกถอนสิทธิ์" จะไม่มีผลกับคนที่ล็อกอินค้างอยู่
 */
import { and, asc, count, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  adminAuditLog,
  users,
  type AdminAction,
  type User,
  type UserRole,
  type UserStatus,
} from "@/db/schema";
import { hashPassword } from "./password";
import { destroyAllUserSessions } from "./session";
import { MIN_PASSWORD_LENGTH } from "./account";
import { checkUserAccess } from "./user-access";
import { buildAuditValues, pruneAuditLog, recordDenied } from "./audit";

/** อธิบายวันหมดอายุแบบอ่านง่ายสำหรับข้อความ audit */
function describeExpiry(value: Date | null): string {
  return value ? `ถึง ${value.toISOString()}` : "ไม่มีกำหนด";
}

export type AdminResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): AdminResult<never> {
  return { ok: false, status, error };
}

/** สถานะที่ admin ตั้งให้คนอื่นได้ */
const SETTABLE_STATUSES: UserStatus[] = ["pending", "active", "revoked"];

export function isSettableStatus(value: unknown): value is UserStatus {
  return typeof value === "string" && SETTABLE_STATUSES.includes(value as UserStatus);
}

export async function isAdmin(userId: number): Promise<boolean> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return user?.role === "admin";
}

/** ข้อมูลผู้ใช้ที่ส่งให้หน้า admin ได้ — จงใจไม่มี passwordHash */
export type ManagedUserDTO = {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  status: UserStatus;
  accessExpiresAt: string | null;
  createdAt: string;
  /** สรุปว่าตอนนี้ใช้งานได้จริงไหม (รวมเงื่อนไขวันหมดอายุแล้ว) — หน้า UI จะได้ไม่ต้องคำนวณเอง */
  usable: boolean;
};

export function toManagedUserDTO(user: User): ManagedUserDTO {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status,
    accessExpiresAt: user.accessExpiresAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    usable: checkUserAccess(user).usable,
  };
}

/** รายชื่อผู้ใช้ทั้งหมด (เฉพาะ admin) — เรียงคนใหม่ที่รออนุมัติให้เห็นง่ายด้วยการเรียงตาม id */
export async function listUsers(actorId: number): Promise<AdminResult<ManagedUserDTO[]>> {
  if (!(await isAdmin(actorId))) return fail(403, "เฉพาะผู้ดูแลระบบเท่านั้น");
  const rows = await db.select().from(users).orderBy(asc(users.id));
  return { ok: true, data: rows.map(toManagedUserDTO) };
}

/** โหลด actor ถ้าเป็น admin จริง (ไม่ใช่ = null) — ใช้ทั้งเช็คสิทธิ์และเอา username ไปลง audit */
async function loadAdminActor(actorId: number): Promise<User | null> {
  const actor = await db.query.users.findFirst({ where: eq(users.id, actorId) });
  return actor?.role === "admin" ? actor : null;
}

/**
 * โหลด actor+target พร้อมตรวจสิทธิ์ผู้กระทำ + กันแก้บัญชีผู้ดูแล (ใช้ร่วมกันทุก mutation)
 * รับ action ที่กำลังพยายามทำเข้ามาด้วย เพื่อบันทึกความพยายามที่ถูกปฏิเสธลง audit (ฝั่ง denied)
 *
 * บันทึกเฉพาะการปฏิเสธที่เป็นสัญญาณข้ามสิทธิ์จริง: ไม่ใช่ admin (403) และ admin แก้ admin อื่น (400)
 * จงใจไม่บันทึก: แก้บัญชีตัวเอง (แค่พลาด ทำที่ /account ได้อยู่แล้ว) และ 404 (ลด noise/ป้องกัน flood)
 */
async function loadTarget(
  actorId: number,
  targetId: number,
  action: AdminAction,
): Promise<AdminResult<{ actor: User; target: User }>> {
  const actor = await loadAdminActor(actorId);
  if (!actor) {
    await recordDenied({
      actorId,
      targetId,
      action,
      reason: "พยายามใช้สิทธิ์ผู้ดูแลระบบทั้งที่ไม่มีสิทธิ์",
    });
    return fail(403, "เฉพาะผู้ดูแลระบบเท่านั้น");
  }
  if (actorId === targetId) {
    return fail(400, "ผู้ดูแลระบบแก้ไขบัญชีตัวเองที่หน้านี้ไม่ได้ — ใช้หน้าตั้งค่าบัญชีแทน");
  }
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) return fail(404, "ไม่พบบัญชีนี้");
  if (target.role === "admin") {
    await recordDenied({
      actorId,
      targetId,
      action,
      reason: "พยายามแก้ไขบัญชีผู้ดูแลระบบอื่น",
    });
    return fail(400, "แก้ไขบัญชีผู้ดูแลระบบด้วยกันไม่ได้");
  }
  return { ok: true, data: { actor, target } };
}

/**
 * ตั้งสถานะ/วันหมดอายุสิทธิ์ให้บัญชีอื่น
 * accessExpiresAt: undefined = ไม่แตะของเดิม, null = ใช้ได้ไม่มีกำหนด, Date = หมดอายุตามเวลานั้น
 */
export async function setUserAccess(input: {
  actorId: number;
  targetId: number;
  status?: UserStatus;
  accessExpiresAt?: Date | null;
}): Promise<AdminResult<ManagedUserDTO>> {
  // เดา action ไว้ตั้งแต่ต้นเพื่อให้ log ฝั่ง denied รู้ว่าพยายามทำอะไร (สถานะ = หลัก, ไม่งั้นตั้งวันหมดอายุ)
  const attempted: AdminAction = input.status !== undefined ? "set_status" : "set_access_expiry";
  const loaded = await loadTarget(input.actorId, input.targetId, attempted);
  if (!loaded.ok) return loaded;
  const { actor, target } = loaded.data;

  if (input.status !== undefined && !isSettableStatus(input.status)) {
    return fail(400, "สถานะไม่ถูกต้อง");
  }
  if (input.accessExpiresAt instanceof Date && Number.isNaN(input.accessExpiresAt.getTime())) {
    return fail(400, "รูปแบบวันหมดอายุไม่ถูกต้อง");
  }

  const patch: Partial<Pick<User, "status" | "accessExpiresAt">> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.accessExpiresAt !== undefined) patch.accessExpiresAt = input.accessExpiresAt;
  if (Object.keys(patch).length === 0) return fail(400, "ไม่มีข้อมูลที่จะแก้ไข");

  // การแก้ข้อมูล + การบันทึก audit ต้องอยู่ในทรานแซกชันเดียวกัน เพื่อไม่ให้เกิด "แก้สำเร็จแต่ log หาย"
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set(patch)
      .where(eq(users.id, input.targetId))
      .returning();

    const parts: string[] = [];
    if (input.status !== undefined) parts.push(`สถานะ → ${input.status}`);
    if (input.accessExpiresAt !== undefined) {
      parts.push(`สิทธิ์ใช้งาน → ${describeExpiry(input.accessExpiresAt)}`);
    }
    await tx.insert(adminAuditLog).values(
      buildAuditValues({
        actor,
        target,
        // ถ้าแก้สถานะให้ถือเป็น set_status เป็นหลัก ไม่งั้นเป็นการตั้งวันหมดอายุ
        action: input.status !== undefined ? "set_status" : "set_access_expiry",
        summary: parts.join(", "),
      }),
    );
    return row;
  });
  await pruneAuditLog();

  // ถ้าผลลัพธ์คือ "ใช้งานไม่ได้แล้ว" ต้องเตะ session ที่ค้างอยู่ออกด้วย ไม่งั้นการเพิกถอนไม่มีผลจริง
  if (!checkUserAccess(updated).usable) {
    await destroyAllUserSessions(input.targetId);
  }
  return { ok: true, data: toManagedUserDTO(updated) };
}

/**
 * เลื่อนขั้น/ลดขั้นผู้ดูแลระบบ — ทางออกฉุกเฉินเมื่อ admin เดิมหาย/ลืมรหัส (ต้องมี admin ≥ 2 คนถึงกู้กันได้)
 *
 * จงใจไม่ผ่าน loadTarget เพราะ loadTarget บล็อกบัญชี admin ทั้งดุ้น (กันแก้สถานะ/รหัสผ่านของ admin)
 * แต่การเปลี่ยน "ขั้น" คือข้อยกเว้นที่ตั้งใจให้ทำกับ admin ได้ จึงมีกติกากันล็อกตัวเองของตัวเอง:
 * - เปลี่ยน role ตัวเองไม่ได้ (กันลดขั้นตัวเองจนหมดสิทธิ์ แล้วไม่มีทางกลับ)
 * - ลด admin คนสุดท้ายไม่ได้ — ระบบต้องเหลือผู้ดูแลอย่างน้อยหนึ่งคนเสมอ ไม่งั้นไม่มีใครจัดการระบบได้อีก
 * - เลื่อนเป็น admin = ตั้ง active + ล้างวันหมดอายุ เพราะผู้ดูแลที่ใช้งานไม่ได้ = ไร้ความหมาย
 */
export async function setUserRole(input: {
  actorId: number;
  targetId: number;
  role: UserRole;
}): Promise<AdminResult<ManagedUserDTO>> {
  const requestedAction: AdminAction = input.role === "admin" ? "promote_admin" : "demote_user";
  const actor = await loadAdminActor(input.actorId);
  if (!actor) {
    await recordDenied({
      actorId: input.actorId,
      targetId: input.targetId,
      action: requestedAction,
      reason: "พยายามเปลี่ยนระดับสิทธิ์ทั้งที่ไม่มีสิทธิ์ผู้ดูแลระบบ",
    });
    return fail(403, "เฉพาะผู้ดูแลระบบเท่านั้น");
  }
  if (input.role !== "admin" && input.role !== "user") return fail(400, "สิทธิ์ไม่ถูกต้อง");
  if (input.actorId === input.targetId) {
    return fail(400, "เปลี่ยนระดับสิทธิ์ของบัญชีตัวเองไม่ได้");
  }

  const target = await db.query.users.findFirst({ where: eq(users.id, input.targetId) });
  if (!target) return fail(404, "ไม่พบบัญชีนี้");

  // ลด admin -> user: ต้องเหลือ admin คนอื่นอย่างน้อยหนึ่งคน (นับ admin ที่ "ไม่ใช่เป้าหมาย")
  if (target.role === "admin" && input.role === "user") {
    const [{ value: otherAdmins }] = await db
      .select({ value: count() })
      .from(users)
      .where(and(eq(users.role, "admin"), ne(users.id, input.targetId)));
    if (otherAdmins === 0) {
      return fail(400, "ต้องมีผู้ดูแลระบบอย่างน้อยหนึ่งคน — ตั้งผู้ดูแลคนอื่นก่อนจึงจะลดขั้นคนนี้ได้");
    }
  }

  const patch: Partial<Pick<User, "role" | "status" | "accessExpiresAt">> = { role: input.role };
  // ผู้ดูแลต้องใช้งานได้เสมอ — เลื่อนขั้นแล้วบังคับ active + ไม่มีวันหมดอายุ
  if (input.role === "admin") {
    patch.status = "active";
    patch.accessExpiresAt = null;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set(patch)
      .where(eq(users.id, input.targetId))
      .returning();
    await tx.insert(adminAuditLog).values(
      buildAuditValues({
        actor,
        target,
        action: requestedAction,
        summary:
          input.role === "admin"
            ? "เลื่อนขั้นเป็นผู้ดูแลระบบ (ตั้งใช้งานได้ทันที)"
            : "ลดขั้นเป็นผู้ใช้ทั่วไป",
      }),
    );
    return row;
  });
  await pruneAuditLog();
  return { ok: true, data: toManagedUserDTO(updated) };
}

/** ตั้งรหัสผ่านใหม่ให้บัญชีอื่น (ไม่ต้องรู้รหัสเดิม — เป็นอำนาจของ admin) */
export async function setUserPassword(input: {
  actorId: number;
  targetId: number;
  newPassword: string;
}): Promise<AdminResult<undefined>> {
  const loaded = await loadTarget(input.actorId, input.targetId, "reset_password");
  if (!loaded.ok) return loaded;
  const { actor, target } = loaded.data;

  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    return fail(400, `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: hashPassword(input.newPassword) })
      .where(eq(users.id, input.targetId));
    await tx.insert(adminAuditLog).values(
      buildAuditValues({
        actor,
        target,
        action: "reset_password",
        // ไม่บันทึกค่ารหัสผ่าน — เก็บแค่ข้อเท็จจริงว่ามีการรีเซ็ต
        summary: "ตั้งรหัสผ่านใหม่ให้ (บัญชีถูกให้ออกจากระบบทุกอุปกรณ์)",
      }),
    );
  });
  await pruneAuditLog();

  // รหัสผ่านเปลี่ยนมือแล้ว session เดิมของเจ้าของบัญชีต้องใช้ไม่ได้อีก
  await destroyAllUserSessions(input.targetId);
  return { ok: true, data: undefined };
}
