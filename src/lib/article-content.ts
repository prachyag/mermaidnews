/**
 * ดึงเนื้อข่าวจริงจากหน้าเว็บสำนักข่าว — วัตถุดิบสำหรับแคปชันแบบยาว
 *
 * ทำไมต้องมี: RSS ให้มาแค่พาดหัวกับเนื้อหาย่อสั้น ๆ ถ้าสั่ง AI ให้ "เขียนยาว" จากแค่นั้น
 * มันจะแต่งข้อมูลที่ไม่มีจริงขึ้นมาเติม ซึ่งอันตรายมากกับคอนเทนต์ข่าว
 * ต้องมีเนื้อข่าวจริงให้อ่านก่อน การเขียนยาวถึงจะมีวัตถุดิบรองรับ
 *
 * ทำไมไม่ใช้ jsdom/readability: เป็น dependency หนักมาก (jsdom ~10MB) ซึ่งทำให้ cold start
 * ของ serverless ช้าลงอย่างมีนัยสำคัญ งานที่ต้องการคือ "เอาย่อหน้าเนื้อข่าวออกมา"
 * ซึ่งทำด้วยการตัด tag แบบตรงไปตรงมาก็พอ และคุมพฤติกรรมได้ชัดกว่า
 */

/** ตัดขนาด HTML ที่ยอมประมวลผล — กันหน้าเว็บยักษ์ทำ regex ทำงานนานผิดปกติ */
const MAX_HTML_BYTES = 600_000;

/** ตัดความยาวเนื้อข่าวที่ส่งให้ AI — คุมจำนวน token ไม่ให้บาน (ข่าวทั่วไปยาวไม่เกินนี้) */
export const MAX_CONTENT_CHARS = 6000;

/** สั้นกว่านี้ถือว่าสกัดไม่สำเร็จ (ได้แต่เมนู/โฆษณา ไม่ใช่เนื้อข่าว) */
const MIN_USEFUL_CHARS = 200;

/**
 * เพดานเวลาโหลดหน้าเว็บ 1 หน้า
 *
 * export ไว้ให้ผู้เรียกคำนวณงบเวลารวมได้ (ดู WORST_ATTEMPT_MS ใน long-form.ts)
 * ถ้าปล่อยให้แต่ละที่เดาเอง วันที่ปรับค่าตรงนี้ งบของอีกฝั่งจะผิดทันทีโดยไม่มีใครรู้
 */
export const CONTENT_TIMEOUT_MS = 8_000;
const DEFAULT_TIMEOUT_MS = CONTENT_TIMEOUT_MS;

/** บล็อกที่ไม่ใช่เนื้อข่าวแน่ ๆ — ตัดทิ้งก่อนสกัด */
const NOISE_TAGS = [
  "script",
  "style",
  "noscript",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
  "figure",
  "figcaption",
];

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/** ตัด tag ที่เป็น noise ทั้งบล็อก (เปิด-ปิด) ออกจาก html */
function stripNoise(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of NOISE_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
    // tag ที่ไม่ปิด (พบได้บ่อยกับ HTML พัง ๆ) — ตัดเฉพาะตัวเปิดทิ้ง
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, "gi"), " ");
  }
  return out;
}

/** หาบล็อกเนื้อข่าวหลัก — ถ้าไม่เจอคืน html ทั้งก้อน */
function mainRegion(html: string): string {
  for (const re of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div\b[^>]*itemprop=["']articleBody["'][^>]*>([\s\S]*?)<\/div>/i,
  ]) {
    const m = html.match(re);
    if (m?.[1] && m[1].length > MIN_USEFUL_CHARS) return m[1];
  }
  return html;
}

function tagText(html: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (text) out.push(text);
  }
  return out;
}

/** อ่าน og:description / meta description เป็นทางสำรองเมื่อสกัดย่อหน้าไม่ได้ */
function metaDescription(html: string): string | null {
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const text = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  return null;
}

/**
 * สกัดเนื้อข่าวจาก HTML — ฟังก์ชันล้วน ไม่แตะเครือข่าย (เทสได้ตรง ๆ)
 * คืนสตริงว่างถ้าหาเนื้อไม่เจอ ผู้เรียกเป็นคนตัดสินว่าจะข้ามข่าวนี้ไหม
 */
export function extractArticleText(html: string): string {
  if (!html) return "";
  const capped = html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;

  const cleaned = stripNoise(capped);
  const region = mainRegion(cleaned);

  // ย่อหน้าเป็นสัญญาณที่ดีที่สุดของเนื้อข่าว — ตัดบรรทัดสั้น ๆ ที่มักเป็นเมนู/ป้ายกำกับทิ้ง
  const paragraphs = tagText(region, "p").filter((t) => t.length >= 40);
  let text = paragraphs.join("\n");

  if (text.length < MIN_USEFUL_CHARS) {
    const fromMeta = metaDescription(capped);
    if (fromMeta && fromMeta.length > text.length) text = fromMeta;
  }

  if (text.length > MAX_CONTENT_CHARS) {
    // ตัดที่ขอบบรรทัดเพื่อไม่ให้ประโยคขาดกลางคัน
    const cut = text.slice(0, MAX_CONTENT_CHARS);
    const lastBreak = cut.lastIndexOf("\n");
    text = lastBreak > MAX_CONTENT_CHARS * 0.6 ? cut.slice(0, lastBreak) : cut;
  }
  return text.trim();
}

export type ContentResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * ดึงหน้าเว็บแล้วสกัดเนื้อข่าว — **ไม่ throw เด็ดขาด** คืน ok:false พร้อมเหตุผลแทน
 * เพราะผู้เรียกต้องข้ามไปข่าวถัดไปได้ ไม่ใช่ล้มทั้งรอบเพราะเว็บเดียวมีปัญหา
 */
export async function fetchArticleContent(
  url: string,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ContentResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "URL ไม่ถูกต้อง" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "รองรับเฉพาะ http/https" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // บางเว็บบล็อก UA แปลก ๆ — ใช้ UA เบราว์เซอร์ปกติ
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return { ok: false, reason: `เว็บตอบกลับ HTTP ${res.status}` };

    const type = res.headers.get("content-type") ?? "";
    if (type && !type.includes("html")) {
      return { ok: false, reason: `ไม่ใช่หน้า HTML (${type.split(";")[0]})` };
    }

    const text = extractArticleText(await res.text());
    if (text.length < MIN_USEFUL_CHARS) {
      return { ok: false, reason: "สกัดเนื้อข่าวไม่ได้ (อาจเป็น paywall หรือหน้าเรนเดอร์ด้วย JS)" };
    }
    return { ok: true, text };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? "หมดเวลาเชื่อมต่อ" : `เชื่อมต่อไม่สำเร็จ (${(err as Error)?.message ?? "?"})`,
    };
  } finally {
    clearTimeout(timer);
  }
}
