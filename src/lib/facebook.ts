const GRAPH_VERSION = process.env.FB_GRAPH_VERSION ?? "v23.0";

export type PublishInput = {
  pageId: string;
  /** Page Access Token ของเพจนี้ (เก็บต่อหัวข้อ — ไม่ใช่ค่ากลางของระบบ) */
  accessToken: string;
  message: string;
  link: string;
  /** ถ้าระบุ = ตั้งเวลาโพส (Facebook กำหนดให้อยู่ระหว่าง 10 นาที – 75 วันข้างหน้า) */
  scheduledAt?: Date;
};

export type PublishResult = {
  postId: string;
  postUrl: string;
};

export class FacebookError extends Error {
  constructor(
    message: string,
    /** config = ตั้งค่าไม่ครบ/ค่าไม่ผ่านเงื่อนไข (ยังไม่ได้ยิงไป Facebook), api = Facebook ปฏิเสธ */
    public readonly kind: "config" | "api",
    public readonly code?: number,
  ) {
    super(message);
  }
}

/** Page ID ของ Facebook เป็นตัวเลขล้วนเสมอ — กันค่าแปลกปลอมถูกต่อเข้า path ของ Graph API */
const PAGE_ID_RE = /^\d+$/;

/** โพสข้อความ + ลิงก์ลง Facebook Page ผ่าน Graph API */
export async function publishToPage(input: PublishInput): Promise<PublishResult> {
  if (!PAGE_ID_RE.test(input.pageId)) {
    throw new FacebookError(
      "Facebook Page ID ต้องเป็นตัวเลขล้วน — ตรวจค่าในหน้าจัดการหัวข้อ",
      "config",
    );
  }

  const params: Record<string, string> = {
    message: input.message,
    link: input.link,
    access_token: input.accessToken,
  };

  if (input.scheduledAt) {
    const unix = Math.floor(input.scheduledAt.getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    if (unix < now + 10 * 60) {
      throw new FacebookError(
        "เวลาตั้งโพสต้องล่วงหน้าอย่างน้อย 10 นาที (ข้อกำหนดของ Facebook)",
        "config",
      );
    }
    if (unix > now + 75 * 24 * 60 * 60) {
      throw new FacebookError(
        "เวลาตั้งโพสต้องไม่เกิน 75 วันข้างหน้า (ข้อกำหนดของ Facebook)",
        "config",
      );
    }
    params.published = "false";
    params.scheduled_publish_time = String(unix);
  }

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(input.pageId)}/feed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    },
  );

  const data = (await res.json()) as {
    id?: string;
    error?: { message?: string; code?: number; type?: string };
  };

  if (!res.ok || data.error || !data.id) {
    const fb = data.error;
    throw new FacebookError(
      fb?.message
        ? `Facebook ตอบกลับ: ${fb.message}${fb.code ? ` (code ${fb.code})` : ""}`
        : `โพสไม่สำเร็จ (HTTP ${res.status})`,
      "api",
      fb?.code,
    );
  }

  return {
    postId: data.id,
    postUrl: `https://www.facebook.com/${data.id}`,
  };
}

/* ------------------------------------------------------------------ *
 * การตรวจสอบการเชื่อมต่อ (ปุ่ม "ทดสอบการเชื่อมต่อ" ในหน้าจัดการหัวข้อ)
 *
 * เหตุผลที่ต้องมี: error ของ Facebook คลุมเครือมาก — code 100 "Object does
 * not exist" เกิดได้ทั้งจาก ID ผิด, ID เป็น App ID, และเพจไม่ได้ให้สิทธิ์
 * ส่วน code 200 เกิดจากใช้ User token แทน Page token การตรวจแยกทีละชั้น
 * ทำให้บอกสาเหตุที่แท้จริงเป็นภาษาไทยได้ตรง ๆ แทนที่จะให้ผู้ใช้เดา
 *
 * ตัวแยกประเภท object ที่ใช้คือฟิลด์ `fan_count` (ตรวจกับ Graph API v23.0 จริง):
 *   - เพจ  -> คืน fan_count ปกติ
 *   - แอป/คน -> error 100 "Tried accessing nonexisting field (fan_count)"
 *   - ID ไม่มีจริง/ไม่มีสิทธิ์ -> error 100 "Object with ID ... does not exist"
 * (เคยลอง ?metadata=1 ซึ่งเป็นวิธีคลาสสิก แต่ v23.0 ไม่คืน metadata.type แล้ว)
 * ------------------------------------------------------------------ */

export type CheckStatus = "ok" | "fail";

export type DiagnosisCheck = {
  label: string;
  status: CheckStatus;
  detail: string;
};

export type Diagnosis = {
  ok: boolean;
  summary: string;
  checks: DiagnosisCheck[];
};

type GraphError = { message: string; code: number };

async function graphGet(
  path: string,
  fields: string,
  token: string,
): Promise<{ data?: Record<string, unknown>; error?: GraphError }> {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(path)}` +
        `?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`,
    );
    const data = (await res.json()) as Record<string, unknown> & {
      error?: { message?: string; code?: number };
    };
    if (data.error) {
      return {
        error: {
          message: data.error.message ?? "ไม่ทราบสาเหตุ",
          code: data.error.code ?? 0,
        },
      };
    }
    return { data };
  } catch (err) {
    return {
      error: {
        message: `ติดต่อ Facebook ไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
        code: 0,
      },
    };
  }
}

/** error แบบ "ฟิลด์นี้ไม่มีในออบเจกต์" = object มีอยู่จริงแต่ไม่ใช่ชนิดที่ขอ */
function isMissingField(error: GraphError, field: string): boolean {
  return error.code === 100 && error.message.includes(`nonexisting field (${field})`);
}

/**
 * ตรวจว่าหัวข้อนี้พร้อมโพสลง Facebook จริงไหม — โดยไม่โพสอะไรทั้งสิ้น (อ่านอย่างเดียว)
 * ตรวจ 2 ด้าน: (1) ID ที่กรอกเป็นเพจจริงไหม (2) token เป็น Page token ของเพจนั้นไหม
 */
export async function diagnoseConnection(input: {
  pageId: string | null;
  accessToken: string | null;
}): Promise<Diagnosis> {
  const checks: DiagnosisCheck[] = [];

  if (!input.pageId) {
    checks.push({
      label: "Facebook Page ID",
      status: "fail",
      detail: "ยังไม่ได้ตั้งค่า — กรอก Page ID ในหัวข้อนี้ก่อน",
    });
  } else if (!PAGE_ID_RE.test(input.pageId)) {
    checks.push({
      label: "Facebook Page ID",
      status: "fail",
      detail:
        "Page ID ต้องเป็นตัวเลขล้วน — ค่าที่กรอกมีอักขระอื่นปน (อย่าใส่ URL หรือชื่อเพจ)",
    });
  }
  if (!input.accessToken) {
    checks.push({
      label: "Page Access Token",
      status: "fail",
      detail: "ยังไม่ได้ตั้งค่า — กรอก token ในหัวข้อนี้ก่อน",
    });
  }
  if (checks.length > 0) {
    return { ok: false, summary: "ตั้งค่ายังไม่ครบ — ยังทดสอบกับ Facebook ไม่ได้", checks };
  }

  const pageId = input.pageId!;
  const token = input.accessToken!;

  // ยิงพร้อมกัน: 2 คำถามเกี่ยวกับ ID ปลายทาง + 2 คำถามเกี่ยวกับตัว token
  const [targetInfo, targetIsPage, tokenInfo, tokenIsPage] = await Promise.all([
    graphGet(pageId, "id,name", token),
    graphGet(pageId, "fan_count", token),
    graphGet("me", "id,name", token),
    graphGet("me", "fan_count", token),
  ]);

  // --- ชั้นที่ 1: token ใช้งานได้ไหม ---
  if (tokenInfo.error) {
    const e = tokenInfo.error;
    checks.push({
      label: "Page Access Token",
      status: "fail",
      detail:
        e.code === 190
          ? `token ใช้ไม่ได้หรือหมดอายุแล้ว — ต้องขอใหม่ตามคู่มือขั้นที่ 3 (Facebook: ${e.message})`
          : `ตรวจ token ไม่สำเร็จ: ${e.message}`,
    });
    return { ok: false, summary: "token ใช้ไม่ได้ — ขอ token ใหม่ก่อน", checks };
  }

  const tokenOwnerId = String(tokenInfo.data?.id ?? "");
  const tokenOwnerName = String(tokenInfo.data?.name ?? "(ไม่ทราบชื่อ)");
  const tokenIsPageToken = !tokenIsPage.error;

  // --- ชั้นที่ 2: ID ที่กรอกเป็น "เพจ" จริงไหม ---
  const targetIsRealPage = !targetInfo.error && !targetIsPage.error;
  if (targetInfo.error) {
    checks.push({
      label: `ID ปลายทาง (${pageId})`,
      status: "fail",
      detail:
        `หา object นี้ไม่เจอด้วย token ปัจจุบัน — เป็นไปได้ 2 อย่าง: ` +
        `Page ID พิมพ์ผิด หรือเพจนี้ไม่ได้ให้สิทธิ์แอปตอน Generate token ` +
        `(Facebook: ${targetInfo.error.message})`,
    });
  } else if (targetIsPage.error && isMissingField(targetIsPage.error, "fan_count")) {
    checks.push({
      label: `ID ปลายทาง (${pageId})`,
      status: "fail",
      detail:
        `มี object ชื่อ "${targetInfo.data?.name}" อยู่จริง แต่ไม่ใช่เพจ — น่าจะเป็น App ID ` +
        `ที่หยิบมาจากหน้า Meta for Developers โดยเข้าใจผิด ` +
        `Page ID ต้องเอาจาก /me/accounts (คู่มือขั้นที่ 3 ข้อ 7) เท่านั้น`,
    });
  } else {
    checks.push({
      label: `ID ปลายทาง (${pageId})`,
      status: "ok",
      detail: `เป็นเพจจริง: "${targetInfo.data?.name}"`,
    });
  }

  // --- ชั้นที่ 3: token เป็น Page token ของ "เพจนี้" ไหม ---
  if (!tokenIsPageToken) {
    checks.push({
      label: "ชนิดของ token",
      status: "fail",
      detail:
        `นี่คือ User token ของบัญชี "${tokenOwnerName}" ไม่ใช่ Page token — ` +
        `โพสจะโดน error code 200 ต้องเอา User token ไปแลกเป็น Page token ที่ ` +
        `/me/accounts ก่อน (คู่มือขั้นที่ 3 ข้อ 7) แล้วเอา access_token ของเพจมาใส่แทน`,
    });
  } else if (!targetIsRealPage) {
    // ตัว token ไม่ได้ผิด — ปัญหาอยู่ที่ ID ปลายทางซึ่งรายงานไปแล้วข้างบน
    // ถ้ารายงานว่า "คนละเพจ" ตรงนี้ด้วยจะกลายเป็นชี้ 2 จุดพร้อมกันจนไม่รู้ว่าต้องแก้อะไร
    checks.push({
      label: "ชนิดของ token",
      status: "ok",
      detail: `ตัว token ใช้ได้ — เป็น Page token ของเพจ "${tokenOwnerName}" (id ${tokenOwnerId})`,
    });
  } else if (tokenOwnerId !== pageId) {
    checks.push({
      label: "ชนิดของ token",
      status: "fail",
      detail:
        `เป็น Page token ถูกชนิดแล้ว แต่เป็นของเพจ "${tokenOwnerName}" (id ${tokenOwnerId}) ` +
        `ซึ่งคนละเพจกับ Page ID ที่ตั้งไว้ — ใน JSON จาก /me/accounts ต้องหยิบ id กับ access_token จากบล็อกเดียวกัน`,
    });
  } else {
    checks.push({
      label: "ชนิดของ token",
      status: "ok",
      detail: `เป็น Page token ของเพจ "${tokenOwnerName}" ตรงกับ Page ID ที่ตั้งไว้`,
    });
  }

  const ok = checks.every((c) => c.status === "ok");
  return {
    ok,
    summary: ok
      ? `พร้อมโพสลงเพจ "${tokenOwnerName}" แล้ว`
      : "ยังโพสไม่ได้ — ดูรายการที่ ❌ ด้านล่าง",
    checks,
  };
}
