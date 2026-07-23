import { describe, expect, it, vi } from "vitest";
import { extractArticleText, fetchArticleContent, MAX_CONTENT_CHARS } from "./article-content";

/** ย่อหน้ายาวพอให้ผ่านเกณฑ์ (>=40 ตัวอักษร) */
const P = (n: number) =>
  `ย่อหน้าที่ ${n} เนื้อข่าวจริงที่มีความยาวมากพอจะถือว่าเป็นเนื้อหาสาระของข่าวชิ้นนี้จริง ๆ`;

function page(body: string, head = "") {
  return `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`;
}

describe("extractArticleText", () => {
  it("ดึงข้อความจากย่อหน้าออกมาได้", () => {
    const text = extractArticleText(page(`<p>${P(1)}</p><p>${P(2)}</p>`));
    expect(text).toContain("ย่อหน้าที่ 1");
    expect(text).toContain("ย่อหน้าที่ 2");
  });

  it("ตัด script/style ทิ้ง ไม่ให้โค้ดปนมาในเนื้อข่าว", () => {
    const html = page(
      `<script>var evil = "ห้ามหลุดมา";</script><style>.x{color:red}</style><p>${P(1)}</p>`,
    );
    const text = extractArticleText(html);
    expect(text).not.toContain("evil");
    expect(text).not.toContain("color:red");
    expect(text).toContain("ย่อหน้าที่ 1");
  });

  it("ตัดเมนู/ส่วนหัว/ส่วนท้ายทิ้ง", () => {
    const html = page(
      `<nav><p>เมนูหลัก หน้าแรก ข่าวเด่น กีฬา บันเทิง เศรษฐกิจ ต่างประเทศ</p></nav>` +
        `<p>${P(1)}</p>` +
        `<footer><p>สงวนลิขสิทธิ์ ติดต่อโฆษณา นโยบายความเป็นส่วนตัว เงื่อนไขการใช้งาน</p></footer>`,
    );
    const text = extractArticleText(html);
    expect(text).toContain("ย่อหน้าที่ 1");
    expect(text).not.toContain("เมนูหลัก");
    expect(text).not.toContain("สงวนลิขสิทธิ์");
  });

  it("เลือกเนื้อใน <article> เป็นหลักเมื่อมี", () => {
    const html = page(
      `<p>ข้อความนอกบทความที่ไม่ควรถูกเลือกมาเพราะอยู่นอกแท็ก article อย่างชัดเจน</p>` +
        `<article><p>${P(1)}</p><p>${P(2)}</p><p>${P(3)}</p></article>`,
    );
    const text = extractArticleText(html);
    expect(text).toContain("ย่อหน้าที่ 1");
    expect(text).not.toContain("ข้อความนอกบทความ");
  });

  it("แปลง HTML entity กลับเป็นตัวอักษรจริง", () => {
    const long = "ข้อความยาวพอสมควรเพื่อให้ผ่านเกณฑ์ความยาวขั้นต่ำของย่อหน้าที่กำหนดไว้";
    const text = extractArticleText(page(`<p>${long} &amp; &quot;อ้างอิง&quot; &#39;ทดสอบ&#39; &nbsp;จบ</p>`));
    expect(text).toContain("&");
    expect(text).toContain('"อ้างอิง"');
    expect(text).toContain("'ทดสอบ'");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&#39;");
  });

  it("ตัด tag ที่ซ้อนอยู่ในย่อหน้าออก เหลือแต่ข้อความ", () => {
    const text = extractArticleText(
      page(`<p>${P(1)} <a href="/x">ลิงก์</a> <strong>ตัวหนา</strong></p>`),
    );
    expect(text).toContain("ลิงก์");
    expect(text).not.toContain("<a");
    expect(text).not.toContain("href");
  });

  it("ข้ามบรรทัดสั้น ๆ ที่มักเป็นป้ายกำกับ ไม่ใช่เนื้อข่าว", () => {
    const text = extractArticleText(page(`<p>แชร์</p><p>12 ก.ค.</p><p>${P(1)}</p>`));
    expect(text).not.toContain("แชร์");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("ถอยไปใช้ og:description เมื่อสกัดย่อหน้าไม่ได้", () => {
    const desc = "สรุปข่าวจาก og:description ที่ยาวมากพอจะใช้เป็นเนื้อหาสำรองได้จริงเมื่อไม่มีย่อหน้าให้สกัด".repeat(3);
    const html = page("<div>ไม่มีย่อหน้าเลย</div>", `<meta property="og:description" content="${desc}">`);
    expect(extractArticleText(html)).toContain("สรุปข่าวจาก og:description");
  });

  it("ตัดความยาวไม่ให้เกินเพดาน (คุม token)", () => {
    const html = page(Array.from({ length: 400 }, (_, i) => `<p>${P(i)}</p>`).join(""));
    const text = extractArticleText(html);
    expect(text.length).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
    expect(text.length).toBeGreaterThan(1000);
  });

  it("HTML ว่าง/ขยะ = คืนค่าว่าง ไม่ throw", () => {
    expect(extractArticleText("")).toBe("");
    expect(extractArticleText("<html></html>")).toBe("");
    expect(extractArticleText("ไม่ใช่ html เลย")).toBe("");
  });

  it("รับมือ tag ที่ไม่ปิดได้ ไม่ค้าง", () => {
    const text = extractArticleText(page(`<script>x=1<p>${P(1)}</p>`));
    expect(typeof text).toBe("string");
  });
});

describe("fetchArticleContent", () => {
  const okHtml = page(`<article><p>${P(1)}</p><p>${P(2)}</p><p>${P(3)}</p></article>`);

  function mockFetch(body: string, init: { status?: number; type?: string } = {}) {
    return vi.fn(async () =>
      new Response(body, {
        status: init.status ?? 200,
        headers: { "content-type": init.type ?? "text/html; charset=utf-8" },
      }),
    ) as unknown as typeof fetch;
  }

  it("ดึงและสกัดสำเร็จ", async () => {
    const res = await fetchArticleContent("https://news.example/a", { fetchImpl: mockFetch(okHtml) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toContain("ย่อหน้าที่ 1");
  });

  it("ส่ง User-Agent แบบเบราว์เซอร์ (บางเว็บบล็อกบอท)", async () => {
    const f = mockFetch(okHtml);
    await fetchArticleContent("https://news.example/a", { fetchImpl: f });
    const headers = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(headers["User-Agent"]).toContain("Mozilla/5.0");
  });

  it.each([403, 404, 429, 500])("HTTP %i = ok:false พร้อมเหตุผล", async (status) => {
    const res = await fetchArticleContent("https://news.example/a", {
      fetchImpl: mockFetch("", { status }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain(String(status));
  });

  it("ไม่ใช่ HTML (เช่น PDF) = ok:false", async () => {
    const res = await fetchArticleContent("https://news.example/a.pdf", {
      fetchImpl: mockFetch("%PDF-1.4", { type: "application/pdf" }),
    });
    expect(res.ok).toBe(false);
  });

  it("หน้า paywall ที่ไม่มีเนื้อ = ok:false (ให้ผู้เรียกข้ามไปข่าวถัดไป)", async () => {
    const res = await fetchArticleContent("https://news.example/a", {
      fetchImpl: mockFetch(page("<div>สมัครสมาชิกเพื่ออ่านต่อ</div>")),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("สกัดเนื้อข่าวไม่ได้");
  });

  it("เน็ตล่ม = ok:false ไม่ throw", async () => {
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await fetchArticleContent("https://news.example/a", { fetchImpl: boom });
    expect(res.ok).toBe(false);
  });

  it("หมดเวลา = ok:false พร้อมบอกว่า timeout", async () => {
    const hang = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const res = await fetchArticleContent("https://news.example/a", { fetchImpl: hang, timeoutMs: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("หมดเวลา");
  });

  it.each(["", "ไม่ใช่ url", "ftp://x.com/a", "javascript:alert(1)"])(
    "URL ใช้ไม่ได้ (%s) = ok:false โดยไม่ยิงเครือข่าย",
    async (url) => {
      const f = vi.fn() as unknown as typeof fetch;
      const res = await fetchArticleContent(url, { fetchImpl: f });
      expect(res.ok).toBe(false);
      expect(f).not.toHaveBeenCalled();
    },
  );
});
