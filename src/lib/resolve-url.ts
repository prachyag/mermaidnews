/**
 * แกะลิงก์เว็บข่าวจริงออกจากลิงก์ redirect ของ Google News
 *
 * ทำไมต้องมี: Facebook ดูด og tag จากลิงก์ที่เราส่งไป ถ้าส่งลิงก์ google ไป
 * มันจะได้ og:title = "Google News" + โลโก้ google ทุกโพสต์เลยขึ้นการ์ดหน้าตา
 * เหมือนกันหมด คนอ่านไม่รู้ว่าเป็นข่าวอะไร (ยืนยันแล้วด้วยการจำลอง facebookexternalhit)
 *
 * วิธีที่ใช้: เลียนแบบสิ่งที่ JS ของหน้า Google News ทำเอง
 *   1. ดึงหน้า article ของ google -> อ่านลายเซ็น (data-n-a-sg) และ timestamp (data-n-a-ts)
 *   2. POST ไป endpoint /_/DotsSplashUi/data/batchexecute พร้อมลายเซ็นนั้น
 *   3. ได้ลิงก์จริงกลับมา
 *
 * ทางอื่นที่ลองแล้วใช้ไม่ได้ (อย่าเสียเวลาลองซ้ำ):
 *   - แกะ base64 จาก token: token รูปแบบใหม่เก็บแค่ id ไม่มี URL ข้างใน
 *   - ตาม HTTP redirect: 302 วนกลับ google แล้วจบที่หน้า JS ไม่มีลิงก์จริงใน HTML
 *   - อ่านจาก RSS: ทุกฟิลด์ใน item เป็นลิงก์ google หมด
 *
 * ⚠️ นี่คือ private API ที่ไม่มีสัญญาว่าจะอยู่ตลอด และเคยพังมาแล้ว (ตอน google
 * เปลี่ยนรูปแบบ token) ฟังก์ชันนี้จึงคืน ok:false แทนการ throw — ให้ผู้เรียก
 * ตัดสินใจถอยไปใช้ลิงก์เดิมได้ ไม่ใช่ทำให้ทั้งระบบพัง
 */

const GOOGLE_NEWS_HOST = "news.google.com";
const BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

/**
 * เพดานเวลาต่อการยิง Google 1 ครั้ง (ฟังก์ชันนี้ยิง 2 ครั้ง = worst case 2 เท่า)
 *
 * เดิมไม่มีเพดานเลย พึ่ง default ของ runtime ซึ่งบน serverless แปลว่า "ค้างจนฟังก์ชันตาย"
 * ทำให้ทั้งคำขอถูกตัดทิ้งเพราะข่าวชิ้นเดียวที่ Google ตอบช้า — เสียงานที่ทำสำเร็จไปแล้วด้วย
 */
export const RESOLVE_TIMEOUT_MS = 6_000;
const DEFAULT_TIMEOUT_MS = RESOLVE_TIMEOUT_MS;

/** ยิง fetch พร้อมเพดานเวลา — คืน null เมื่อหมดเวลา ให้ผู้เรียกแปลงเป็น reason เอง */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type ResolveResult =
  | { ok: true; url: string; /** true = ลิงก์เดิมไม่ใช่ของ google อยู่แล้ว ไม่ได้แกะอะไร */ passthrough?: boolean }
  | { ok: false; reason: string };

/** ลิงก์นี้เป็นลิงก์ redirect ของ Google News ที่ต้องแกะไหม */
export function isGoogleNewsUrl(url: string): boolean {
  try {
    return new URL(url).hostname === GOOGLE_NEWS_HOST;
  } catch {
    return false;
  }
}

/**
 * ตรวจว่าลิงก์ที่แกะได้ใช้การได้จริง
 *
 * หมายเหตุ: เคยคิดจะเทียบ hostname กับชื่อสำนักข่าว (source) แต่ใช้ไม่ได้จริง —
 * "ผู้จัดการออนไลน์" -> mgronline.com, "LINE TODAY" -> today.line.me ไม่มีทางเทียบตรง
 * เหลือแค่เงื่อนไขที่เชื่อถือได้: ต้องเป็น http(s) และต้องไม่ใช่โดเมน google
 */
function isUsableArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return !/(^|\.)google\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** ถอดลิงก์จริงออกจากผลลัพธ์ batchexecute (รูปแบบ: )]}' แล้วตามด้วย JSON ซ้อน JSON) */
function extractUrl(text: string): string | null {
  const cleaned = text.replace(/^\)\]\}'/, "").trim();
  try {
    const rows = JSON.parse(cleaned) as unknown[][];
    for (const row of rows) {
      if (row?.[0] !== "wrb.fr" || typeof row[2] !== "string") continue;
      const inner = JSON.parse(row[2]) as unknown[];
      const found = inner.find((v) => typeof v === "string" && isUsableArticleUrl(v));
      if (typeof found === "string") return found;
    }
  } catch {
    // รูปแบบเปลี่ยนไป — ลองกวาดหา URL ที่ใช้ได้แบบหยาบ ๆ เป็นทางสำรอง
  }
  for (const m of cleaned.matchAll(/https?:\\?\/\\?\/[^\s\\"']+/g)) {
    const candidate = m[0].replace(/\\/g, "");
    if (isUsableArticleUrl(candidate)) return candidate;
  }
  return null;
}

/**
 * แกะลิงก์จริง — ถ้าลิงก์ที่ส่งมาไม่ใช่ของ google จะคืนกลับไปเลย (passthrough)
 * fetchImpl เปิดไว้ให้เทสสลับตัวยิง HTTP ได้ (เทสต้องไม่ยิงเน็ตจริง)
 */
export async function resolveArticleUrl(
  url: string,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ResolveResult> {
  if (!isGoogleNewsUrl(url)) {
    return isUsableArticleUrl(url)
      ? { ok: true, url, passthrough: true }
      : { ok: false, reason: "ลิงก์ต้นทางไม่ใช่ URL ที่ใช้ได้" };
  }

  let html: string;
  try {
    const page = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: { "User-Agent": UA } },
      timeoutMs,
    );
    if (!page.ok) return { ok: false, reason: `เปิดหน้า Google News ไม่ได้ (HTTP ${page.status})` };
    html = await page.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "หมดเวลาเชื่อมต่อ Google News" };
    }
    return {
      ok: false,
      reason: `ติดต่อ Google News ไม่ได้: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const sig = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sig || !ts) {
    // อาการนี้ = google เปลี่ยนโครงหน้าเว็บแล้ว วิธีนี้ใช้ไม่ได้อีกต่อไป
    return { ok: false, reason: "ไม่พบลายเซ็นในหน้า Google News (Google อาจเปลี่ยนรูปแบบแล้ว)" };
  }

  const articleId = url.split("/articles/")[1]?.split("?")[0];
  if (!articleId) return { ok: false, reason: "ลิงก์ Google News ไม่มีรหัสบทความ" };

  const request = [
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X",
      "X",
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    articleId,
    Number(ts),
    sig,
  ];
  const payload = [[["Fbv4je", JSON.stringify(request), null, "1"]]];

  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      BATCH_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": UA,
        },
        body: new URLSearchParams({ "f.req": JSON.stringify(payload) }).toString(),
      },
      timeoutMs,
    );
    if (!res.ok) return { ok: false, reason: `Google ปฏิเสธคำขอแกะลิงก์ (HTTP ${res.status})` };

    const resolved = extractUrl(await res.text());
    if (!resolved) return { ok: false, reason: "Google ไม่ได้ส่งลิงก์จริงกลับมา" };
    return { ok: true, url: resolved };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, reason: "หมดเวลาเชื่อมต่อ Google News" };
    }
    return {
      ok: false,
      reason: `แกะลิงก์ไม่สำเร็จ: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
