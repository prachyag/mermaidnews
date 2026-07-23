/**
 * สถิติการเรียก AI — บันทึกทุกครั้งที่เรียก แล้วสรุปให้เห็นว่ากำลังเสื่อมหรือยัง
 *
 * ที่มา: เหตุการณ์ 23 ก.ค. 2569 ฟีเจอร์ AI ล่ม 100% โดยระบบไม่รู้ตัวจนผู้ใช้มาแจ้ง
 * (ดู docs/POSTMORTEM-2026-07-23-gemini-invalid-argument.md)
 *
 * บทเรียนที่สะท้อนอยู่ในไฟล์นี้: อาการเสื่อมที่อันตรายที่สุด "ไม่ throw error"
 * — ขอ 10 ข่าวได้กลับ 1 ชิ้น ถือว่า request สำเร็จ แต่ผู้ใช้เสียข่าวไป 9 ชิ้น
 * การวัดจึงต้องดู "ความครบ" (returned/requested) ไม่ใช่แค่ "สำเร็จ/ล้มเหลว"
 */
import { and, desc, eq, gte, inArray, notInArray, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { aiCallLogs, topics, users, type AiCallLog, type NewAiCallLog } from "@/db/schema";

/** เก็บสถิติสูงสุดกี่แถว — เกินแล้วลบเก่าสุดทิ้งอัตโนมัติ (เหมือน audit log) */
export const AI_STATS_MAX_ENTRIES = Number(process.env.AI_STATS_MAX_ENTRIES) || 2000;

/** ต่ำกว่านี้ถือว่า "ตอบไม่ครบจนน่ากังวล" (ได้ผลกลับน้อยกว่า 90% ของที่ขอ) */
const COMPLETENESS_WARN = 0.9;
/** อัตราสำเร็จต่ำกว่านี้ = เสื่อมหนัก */
const SUCCESS_RATE_WARN = 0.9;
/** ช้ากว่านี้ต่อ 1 ข่าว = เริ่มผิดปกติ (วัดจากของจริงได้ ~0.8 วิ/ข่าว ตอนสุขภาพดี) */
const SLOW_MS_PER_ARTICLE = 4000;

export type AiCallInput = {
  topicId: number | null;
  topicName: string;
  model: string;
  mode: "batch" | "single";
  requested: number;
  returned: number;
  durationMs: number;
  ok: boolean;
  errorMessage?: string | null;
};

/** ประกอบค่าที่จะบันทึก — ล้วน ไม่แตะ DB (เทสได้โดยไม่เปิดฐานข้อมูล) */
export function buildAiCallValues(input: AiCallInput): NewAiCallLog {
  return {
    topicId: input.topicId,
    topicName: input.topicName,
    model: input.model,
    mode: input.mode,
    requested: input.requested,
    // กันค่าเพี้ยน: ตอบกลับมากกว่าที่ขอไม่ควรเกิด และค่าติดลบไม่มีความหมาย
    returned: Math.max(0, Math.min(input.returned, input.requested)),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ok: input.ok,
    errorMessage: input.errorMessage ?? null,
  };
}

/**
 * บันทึกสถิติ 1 ครั้ง — ห้าม throw เด็ดขาด
 * การเก็บสถิติต้องไม่ทำให้งานหลัก (ประมวลผลข่าว) พัง ถ้าเขียน log ไม่ได้ก็แค่เตือนแล้วไปต่อ
 */
export async function recordAiCall(input: AiCallInput): Promise<void> {
  try {
    await db.insert(aiCallLogs).values(buildAiCallValues(input));
    await pruneAiCallLogs();
  } catch (err) {
    console.warn("[ai-stats] บันทึกสถิติการเรียก AI ไม่สำเร็จ:", err);
  }
}

/** ลบสถิติเก่าทิ้งให้เหลือไม่เกิน max (เก็บใหม่สุด) */
export async function pruneAiCallLogs(max: number = AI_STATS_MAX_ENTRIES): Promise<void> {
  const survivors = db
    .select({ id: aiCallLogs.id })
    .from(aiCallLogs)
    .orderBy(desc(aiCallLogs.createdAt), desc(aiCallLogs.id))
    .limit(max);
  await db.delete(aiCallLogs).where(notInArray(aiCallLogs.id, survivors));
}

export type AiHealth = "ok" | "degraded" | "down" | "unknown";

export type AiStatsSummary = {
  totalCalls: number;
  okCalls: number;
  failedCalls: number;
  /** อัตราสำเร็จ 0–1 */
  successRate: number;
  requested: number;
  returned: number;
  /** ความครบของผลลัพธ์ 0–1 — ต่ำ = "สำเร็จแต่ได้ข่าวไม่ครบ" */
  completeness: number;
  avgDurationMs: number;
  /** เวลาเฉลี่ยต่อข่าว 1 ชิ้น — เทียบข้ามขนาดชุดได้ */
  avgMsPerArticle: number;
  health: AiHealth;
  reasons: string[];
  lastError: string | null;
  lastCallAt: string | null;
};

/**
 * ตัดสินสุขภาพจากตัวเลขที่สรุปมา — ฟังก์ชันล้วน แยกออกมาเพื่อเทสทุกขอบเขตได้ง่าย
 *
 * down = ล้มเหลวทุกครั้ง (แบบเหตุการณ์ 23 ก.ค. ที่ config ผิดจนพังทั้งหมด)
 * degraded = ยังทำงานได้แต่มีสัญญาณเสื่อม — จุดที่อยากจับให้ได้ "ก่อน" กลายเป็น down
 */
export function assessHealth(s: {
  totalCalls: number;
  successRate: number;
  completeness: number;
  avgMsPerArticle: number;
}): { health: AiHealth; reasons: string[] } {
  if (s.totalCalls === 0) return { health: "unknown", reasons: ["ยังไม่มีการเรียก AI"] };

  const reasons: string[] = [];
  if (s.successRate === 0) {
    return { health: "down", reasons: ["การเรียก AI ล้มเหลวทุกครั้ง"] };
  }
  if (s.successRate < SUCCESS_RATE_WARN) {
    reasons.push(`อัตราสำเร็จ ${(s.successRate * 100).toFixed(0)}% (ต่ำกว่าเกณฑ์ 90%)`);
  }
  if (s.completeness < COMPLETENESS_WARN) {
    reasons.push(
      `AI ตอบกลับไม่ครบ — ได้ผลเพียง ${(s.completeness * 100).toFixed(0)}% ของข่าวที่ส่งไป`,
    );
  }
  if (s.avgMsPerArticle > SLOW_MS_PER_ARTICLE) {
    reasons.push(`ช้าผิดปกติ ${(s.avgMsPerArticle / 1000).toFixed(1)} วินาทีต่อข่าว 1 ชิ้น`);
  }
  return reasons.length > 0 ? { health: "degraded", reasons } : { health: "ok", reasons: [] };
}

/** เงื่อนไขจำกัดขอบเขต: admin เห็นทั้งระบบ, ผู้ใช้ทั่วไปเห็นเฉพาะหัวข้อตัวเอง */
async function scopeFor(userId: number, sinceHours: number): Promise<SQL | undefined> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const conditions: SQL[] = [gte(aiCallLogs.createdAt, since)];

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user?.role !== "admin") {
    const owned = await db
      .select({ id: topics.id })
      .from(topics)
      .where(eq(topics.userId, userId));
    const ids = owned.map((t) => t.id);
    // ไม่มีหัวข้อเลย = ไม่ควรเห็นสถิติของใคร — ใช้เงื่อนไขที่เป็นเท็จเสมอ
    if (ids.length === 0) return eq(aiCallLogs.id, -1);
    conditions.push(inArray(aiCallLogs.topicId, ids));
  }
  return and(...conditions);
}

/** สรุปสถิติในช่วงเวลาที่กำหนด (ค่าเริ่มต้น 24 ชั่วโมงล่าสุด) */
export async function summarizeAiCalls(
  userId: number,
  { sinceHours = 24 }: { sinceHours?: number } = {},
): Promise<AiStatsSummary> {
  const rows = await db
    .select()
    .from(aiCallLogs)
    .where(await scopeFor(userId, sinceHours))
    .orderBy(desc(aiCallLogs.createdAt), desc(aiCallLogs.id));

  return summarize(rows);
}

/** คำนวณสรุปจากแถวดิบ — แยกออกมาเพื่อเทสได้โดยไม่ต้องผ่าน DB */
export function summarize(rows: AiCallLog[]): AiStatsSummary {
  const totalCalls = rows.length;
  const okRows = rows.filter((r) => r.ok);
  const requested = rows.reduce((n, r) => n + r.requested, 0);
  const returned = rows.reduce((n, r) => n + r.returned, 0);
  const totalMs = rows.reduce((n, r) => n + r.durationMs, 0);

  const successRate = totalCalls === 0 ? 0 : okRows.length / totalCalls;
  const completeness = requested === 0 ? 1 : returned / requested;
  const avgDurationMs = totalCalls === 0 ? 0 : Math.round(totalMs / totalCalls);
  const avgMsPerArticle = requested === 0 ? 0 : Math.round(totalMs / requested);

  const { health, reasons } = assessHealth({
    totalCalls,
    successRate,
    completeness,
    avgMsPerArticle,
  });

  return {
    totalCalls,
    okCalls: okRows.length,
    failedCalls: totalCalls - okRows.length,
    successRate,
    requested,
    returned,
    completeness,
    avgDurationMs,
    avgMsPerArticle,
    health,
    reasons,
    lastError: rows.find((r) => !r.ok)?.errorMessage ?? null,
    lastCallAt: rows[0]?.createdAt.toISOString() ?? null,
  };
}

export type AiCallDTO = {
  id: number;
  topicName: string;
  model: string;
  mode: "batch" | "single";
  requested: number;
  returned: number;
  durationMs: number;
  ok: boolean;
  errorMessage: string | null;
  createdAt: string;
};

/** รายการเรียกล่าสุด (ตามขอบเขตสิทธิ์เดียวกับ summarizeAiCalls) */
export async function listRecentAiCalls(
  userId: number,
  { limit = 20, sinceHours = 24 }: { limit?: number; sinceHours?: number } = {},
): Promise<AiCallDTO[]> {
  const rows = await db
    .select()
    .from(aiCallLogs)
    .where(await scopeFor(userId, sinceHours))
    .orderBy(desc(aiCallLogs.createdAt), desc(aiCallLogs.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    topicName: r.topicName,
    model: r.model,
    mode: r.mode,
    requested: r.requested,
    returned: r.returned,
    durationMs: r.durationMs,
    ok: r.ok,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
  }));
}
