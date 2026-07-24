import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessArticleInput } from "./provider";

/**
 * เทสของตัวเรียก Gemini — เน้นเรื่อง "ต้องไม่ค้าง" เท่านั้น
 *
 * ที่มา: production เจอ FUNCTION_INVOCATION_TIMEOUT ซ้ำ ๆ เพราะ SDK ไม่มี timeout ให้เอง
 * พอ Gemini ไม่ตอบ ฟังก์ชันก็ค้างจนแพลตฟอร์มฆ่าทิ้ง ผู้ใช้ไม่ได้แม้แต่ข้อความบอกเหตุ
 * และงานที่ทำสำเร็จไปแล้วในคำขอเดียวกันก็หายไปด้วย
 *
 * ไม่ยิงเน็ตจริง — mock ตัว SDK ทั้งก้อน
 */

const mockGenerateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: (...a: unknown[]) => mockGenerateContent(...a) };
  },
  Type: {
    OBJECT: "OBJECT",
    ARRAY: "ARRAY",
    STRING: "STRING",
    NUMBER: "NUMBER",
    BOOLEAN: "BOOLEAN",
    INTEGER: "INTEGER",
  },
}));

// ต้องตั้งก่อน import เพราะโมดูลอ่าน env ตอนโหลด
process.env.GEMINI_TIMEOUT_MS = "150";
const { GeminiProvider, AI_TIMEOUT_MS } = await import("./gemini");

const provider = new GeminiProvider("test-key");

const input: ProcessArticleInput = {
  topicName: "นางเงือก",
  aiContext: null,
  captionStyle: null,
  title: "ข่าวทดสอบ",
  description: null,
  source: null,
};

/** คำตอบที่ถูกต้องตามที่ processArticle คาดหวัง */
function goodResponse() {
  return {
    text: JSON.stringify({
      relevant: true,
      relevanceScore: 0.9,
      interestScore: 0.8,
      summary: "ส",
      caption: "ค",
      hashtags: ["#a"],
    }),
    candidates: [{ finishReason: "STOP" }],
  };
}

/** ค้างไปเรื่อย ๆ จนกว่าจะถูกสั่งยกเลิก — จำลอง Gemini ที่ไม่ตอบ */
function hangUntilAborted() {
  return (req: { config?: { abortSignal?: AbortSignal } }) =>
    new Promise((_resolve, reject) => {
      req.config?.abortSignal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("เพดานเวลาของการเรียก Gemini", () => {
  it("อ่านค่าจาก env ได้", () => {
    expect(AI_TIMEOUT_MS).toBe(150);
  });

  it("ส่ง abortSignal ไปกับคำขอ (ไม่งั้นเพดานเวลาไม่มีผลอะไรเลย)", async () => {
    mockGenerateContent.mockResolvedValue(goodResponse());

    await provider.processArticle(input);

    const req = mockGenerateContent.mock.calls[0][0];
    expect(req.config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("Gemini ไม่ตอบ = ยกเลิกเองแล้วโยน error ที่อ่านรู้เรื่อง ไม่ค้างรอตลอดไป", async () => {
    mockGenerateContent.mockImplementation(hangUntilAborted());

    const startedAt = Date.now();
    await expect(provider.processArticle(input)).rejects.toThrow(/ไม่ตอบภายใน/);

    // ต้องคืนการควบคุมกลับมาไว ๆ ไม่ใช่รอจนแพลตฟอร์มฆ่าทิ้ง
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it("ตอบทันเวลา = ทำงานปกติ ไม่ถูกยกเลิก", async () => {
    mockGenerateContent.mockResolvedValue(goodResponse());

    const result = await provider.processArticle(input);

    expect(result).toMatchObject({ relevant: true, caption: "ค" });
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  /**
   * ตอบว่างคือให้ลองใหม่ได้ แต่ต้องไม่ลองจนทะลุเพดานเวลา
   * (เดิมลองครบ 3 ครั้งเสมอ ไม่ว่าจะใช้เวลาไปเท่าไหร่แล้ว)
   */
  it("ตอบกลับว่างจนหมดเวลา = เลิกลองใหม่ แล้วบอกว่าหมดเวลา", async () => {
    mockGenerateContent.mockResolvedValue({ text: "", candidates: [{ finishReason: "STOP" }] });

    await expect(provider.processArticle(input)).rejects.toThrow(/ไม่ตอบภายใน|ตอบกลับว่าง/);
  });
});
