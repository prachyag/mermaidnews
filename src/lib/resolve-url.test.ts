import { describe, expect, it, vi } from "vitest";
import { isGoogleNewsUrl, resolveArticleUrl } from "@/lib/resolve-url";

/**
 * เทสนี้ไม่ยิงเน็ตจริง — ปลอมตัว fetch เอา
 *
 * สิ่งที่ต้องกันให้ได้: วิธีแกะลิงก์นี้พึ่ง private API ของ Google ที่จะพังสักวัน
 * เมื่อพัง ต้องคืน ok:false พร้อมเหตุผลที่อ่านรู้เรื่อง ไม่ใช่ throw หรือคืนขยะ
 * เพราะผู้เรียก (ตอนโพส) ต้องถอยไปใช้ลิงก์เดิมได้ ไม่ใช่ทำให้โพสพังทั้งหมด
 */

const GOOGLE_URL = "https://news.google.com/rss/articles/CBMiTEST123";
const REAL_URL = "https://www.sanook.com/campus/1431487/";

const pageWithSignature = `<html><body><c-wiz data-n-a-sg="SIGNATURE_ABC" data-n-a-ts="1784277981" data-n-a-id="CBMiTEST123"></c-wiz></body></html>`;

/** ผลลัพธ์รูปแบบเดียวกับที่ batchexecute ของจริงตอบกลับ */
function batchResponse(url: string): string {
  return `)]}'\n\n${JSON.stringify([
    ["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", url]), null, null, null, "generic"],
    ["di", 27],
  ])}`;
}

const res = (body: string, ok = true, status = 200) =>
  ({ ok, status, text: async () => body }) as Response;

/** ตัว fetch ปลอมที่ทำงานถูกต้อง: หน้าแรกคืน HTML มีลายเซ็น, POST คืนลิงก์จริง */
function happyFetch(realUrl = REAL_URL) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("batchexecute")) return res(batchResponse(realUrl));
    return res(pageWithSignature);
  }) as unknown as typeof fetch;
}

describe("isGoogleNewsUrl", () => {
  it.each([
    ["https://news.google.com/rss/articles/CBMiX", true],
    ["https://www.sanook.com/campus/1", false],
    ["https://google.com/x", false],
    ["ไม่ใช่ url", false],
    ["", false],
  ])("isGoogleNewsUrl(%j) = %s", (url, expected) => {
    expect(isGoogleNewsUrl(url)).toBe(expected);
  });
});

describe("resolveArticleUrl — ทางที่สำเร็จ", () => {
  it("แกะลิงก์ google เป็นลิงก์เว็บข่าวจริง", async () => {
    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl: happyFetch() });

    expect(result).toEqual({ ok: true, url: REAL_URL });
  });

  it("ส่งลายเซ็นและ id ที่อ่านจากหน้าเว็บไปกับคำขอ (ไม่งั้น Google ปฏิเสธ)", async () => {
    const fetchImpl = happyFetch();
    await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    const body = String(init.body);
    expect(body).toContain("SIGNATURE_ABC");
    expect(body).toContain("1784277981");
    expect(body).toContain("CBMiTEST123");
  });

  it("ลิงก์ที่ไม่ใช่ของ google ส่งคืนเลย ไม่ยิงเน็ต (กันเสียเวลาเปล่า)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const result = await resolveArticleUrl(REAL_URL, { fetchImpl });

    expect(result).toEqual({ ok: true, url: REAL_URL, passthrough: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("อ่านลิงก์ได้แม้รูปแบบ JSON เปลี่ยนไป (ทางสำรองด้วยการกวาดหา URL)", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("batchexecute")) {
        return res(`)]}'\n[["อะไรก็ไม่รู้","${REAL_URL}"]]`);
      }
      return res(pageWithSignature);
    }) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    expect(result).toEqual({ ok: true, url: REAL_URL });
  });
});

describe("resolveArticleUrl — ทางที่พัง ต้องคืน ok:false ไม่ใช่ throw", () => {
  it("Google เปลี่ยนหน้าเว็บจนไม่มีลายเซ็น", async () => {
    const fetchImpl = vi.fn(async () => res("<html>ไม่มีลายเซ็น</html>")) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ไม่พบลายเซ็น");
  });

  it("เปิดหน้า Google ไม่ได้ (HTTP พัง)", async () => {
    const fetchImpl = vi.fn(async () => res("", false, 503)) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("503");
  });

  it("เน็ตล่ม (fetch โยน error) — ต้องไม่ throw ออกไป", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ECONNRESET");
  });

  /**
   * เดิมไม่มีเพดานเวลาเลย — Google ค้างทีเดียวกินงบทั้งคำขอจนฟังก์ชันถูกตัดทิ้ง
   * งานที่สำเร็จไปแล้วในคำขอเดียวกันก็หายตามไปด้วย
   */
  it("Google ตอบช้าเกินเพดาน = ยกเลิกแล้วคืนเหตุผล ไม่ปล่อยค้าง", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    ) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl, timeoutMs: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("หมดเวลา");
  });

  it("ส่ง signal ไปกับทุกคำขอ (ไม่งั้นเพดานเวลาไม่มีผล)", async () => {
    const fetchImpl = happyFetch();
    await resolveArticleUrl(GOOGLE_URL, { fetchImpl });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, init] of calls) expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("batchexecute ตอบ error", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("batchexecute")) return res("", false, 400);
      return res(pageWithSignature);
    }) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("400");
  });

  it("Google ตอบกลับแต่ไม่มีลิงก์จริงในนั้น", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("batchexecute")) return res(`)]}'\n[["wrb.fr","Fbv4je","[]"]]`);
      return res(pageWithSignature);
    }) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ไม่ได้ส่งลิงก์จริง");
  });

  it("Google คืนลิงก์ google มาเอง -> ต้องไม่รับ (โพสไปก็ได้การ์ด Google News เหมือนเดิม)", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("batchexecute")) {
        return res(batchResponse("https://news.google.com/อะไรสักอย่าง"));
      }
      return res(pageWithSignature);
    }) as unknown as typeof fetch;

    const result = await resolveArticleUrl(GOOGLE_URL, { fetchImpl });

    expect(result.ok).toBe(false);
  });

  it("ลิงก์ google ที่ไม่มีรหัสบทความ", async () => {
    const fetchImpl = vi.fn(async () => res(pageWithSignature)) as unknown as typeof fetch;

    const result = await resolveArticleUrl("https://news.google.com/foo", { fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("รหัสบทความ");
  });

  it("ลิงก์ต้นทางใช้ไม่ได้เลย", async () => {
    const result = await resolveArticleUrl("ไม่ใช่ url", {
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
  });
});
