import { GoogleGenAI, Type } from "@google/genai";
import type {
  AiProvider,
  ArticleAssessment,
  BatchAssessment,
  ProcessArticleInput,
  ProcessBatchInput,
} from "./provider";

// ใช้ alias "-latest" เพื่อให้ Google ชี้ไปรุ่น flash ปัจจุบันเสมอ (รุ่นระบุเลขเวอร์ชันมีโอกาสถูกปลดสำหรับผู้ใช้ใหม่)
// ใช้ || ไม่ใช่ ?? เพราะ env ที่ตั้งเป็นสตริงว่างต้องตกมาที่ค่า default ด้วย (?? จะปล่อยผ่านแล้วยิงไปหา model "")
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";

/** ชื่อรุ่นที่ใช้อยู่จริง — เปิดให้ระบบสถิติบันทึกไว้ จะได้เห็นว่าสถิติเปลี่ยนตอนรุ่นเปลี่ยนไหม */
export const AI_MODEL_NAME = MODEL;

/**
 * งบ "คิดก่อนตอบ" (thinking) ต่อ 1 request
 *
 * ทำไมต้องจำกัด: งานนี้เป็นการคัดกรอง+เขียนแคปชันสั้น ๆ ไม่ต้องให้เหตุผลหลายขั้น
 * ถ้าปล่อยค่า default โมเดลคิดยาวมากกับ prompt ที่มีกฎเยอะ — วัดได้ 124 วินาที/ชุด
 * และ thinking token กินโควตา output จน JSON ถูกตัดกลางคัน
 *
 * ทำไมไม่ใช่ 0: เคยใช้ 0 (ปิดสนิท) และใช้ได้จริงจนถึงกลางปี 2026 แต่ alias "-latest"
 * ถูก Google ขยับไปรุ่นใหม่ที่ "ห้ามปิด thinking สนิท" ทำให้ 0 กลายเป็นค่าไม่ถูกต้อง
 * → ทุก request พังด้วย 400 INVALID_ARGUMENT (พังพร้อมกันทั้งระบบ ไม่ใช่แค่บางข่าว)
 * ค่าบวกน้อย ๆ ให้ผลใกล้เคียงการปิด แต่ไม่ผิดกติกาของรุ่นใหม่
 */
const THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET) || 128;

/**
 * เพดาน output ต่อ 1 request — **นับรวม thinking token ด้วย** (จุดนี้สำคัญมาก วัดจาก API จริง)
 *
 * ตอนที่ยังปิด thinking ได้ (thinkingBudget: 0) ค่า 8192 พอเหลือเฟือเพราะเป็นเนื้อคำตอบล้วน
 * พอรุ่นใหม่บังคับให้มี thinking โควตาก้อนเดียวกันถูกแบ่งไปให้การคิด เหลือให้เขียนคำตอบไม่พอ
 * อาการที่เจอ: finishReason=MAX_TOKENS, JSON ถูกตัดกลางคัน, หรือได้ relevant=true แต่ไม่มีแคปชัน
 * จึงต้องตั้งให้กว้างพอสำหรับ "คิด + ตอบ" รวมกัน
 */
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 32768;

const GENERATION_CONFIG = {
  temperature: 0.4,
  thinkingConfig: { thinkingBudget: THINKING_BUDGET },
  maxOutputTokens: MAX_OUTPUT_TOKENS,
} as const;

/** config เดียวกันแต่ตัด thinkingConfig ออก — ใช้เป็นทางถอยเมื่อรุ่นใหม่ไม่รับ thinkingConfig */
const GENERATION_CONFIG_NO_THINKING = {
  temperature: GENERATION_CONFIG.temperature,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
} as const;

/** จำนวนครั้งสูงสุดที่ยิงซ้ำเมื่อเจออาการชั่วคราว (ตอบกลับว่าง) */
const MAX_ATTEMPTS = 3;
/** หน่วงก่อนลองใหม่ คูณตามรอบ (1x, 2x) — กันยิงรัวใส่ API ที่กำลังมีปัญหา */
const RETRY_DELAY_MS = 700;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isInvalidArgument(err: unknown): boolean {
  return /INVALID_ARGUMENT|invalid argument/i.test(
    err instanceof Error ? err.message : String(err),
  );
}

/** โยน error ที่อ่านรู้เรื่องเมื่อผลลัพธ์ถูกตัดกลางคัน แทนที่จะไปพังตอน JSON.parse แบบงง ๆ */
function assertNotTruncated(finishReason: string | undefined): void {
  if (finishReason === "MAX_TOKENS") {
    throw new Error(
      "ผลลัพธ์จาก Gemini ยาวเกินโควตา output จนถูกตัดกลางคัน — ลดค่า GEMINI_BATCH_SIZE ลง",
    );
  }
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    relevant: { type: Type.BOOLEAN },
    relevanceScore: { type: Type.NUMBER },
    interestScore: { type: Type.NUMBER },
    summary: { type: Type.STRING, nullable: true },
    caption: { type: Type.STRING, nullable: true },
    hashtags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      nullable: true,
    },
  },
  required: ["relevant", "relevanceScore", "interestScore"],
} as const;

/**
 * schema ของชุด (batch) — ห่อ array ไว้ใน object เพราะ structured output ของ Gemini
 * เสถียรกว่าเมื่อ top-level เป็น OBJECT
 * `id` เป็น required เพื่อบังคับให้โมเดลระบุว่าผลนี้เป็นของข่าวชิ้นไหน (กันสลับผล)
 */
const batchResponseSchema = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER },
          relevant: { type: Type.BOOLEAN },
          relevanceScore: { type: Type.NUMBER },
          interestScore: { type: Type.NUMBER },
          summary: { type: Type.STRING, nullable: true },
          caption: { type: Type.STRING, nullable: true },
          hashtags: { type: Type.ARRAY, items: { type: Type.STRING }, nullable: true },
        },
        required: ["id", "relevant", "relevanceScore", "interestScore"],
      },
    },
  },
  required: ["results"],
} as const;

/** ส่วนบรรยายงานที่เหมือนกันทั้งแบบเดี่ยวและแบบชุด — ส่งครั้งเดียวต่อชุดคือที่มาของการประหยัด token */
/**
 * คำสั่งเรื่องความยาว/เนื้อหาของแคปชัน — ต่างกันตามการตั้งค่าของหัวข้อ
 *
 * แยกเป็นฟังก์ชันเพราะใช้ทั้งแบบเดี่ยวและแบบชุด ต้องพูดตรงกันเป๊ะ
 * ไม่งั้นข่าวที่ประมวลผลคนละทางจะได้แคปชันคนละแบบทั้งที่ตั้งค่าเดียวกัน
 */
function captionInstruction(includeSummary: boolean | undefined): string {
  return includeSummary
    ? "แคปชันสำหรับโพส Facebook เป็นภาษาไทย — **เล่าเนื้อข่าวให้ครบถ้วนในตัวแคปชันเอง** " +
        "(ใคร ทำอะไร ที่ไหน เมื่อไหร่ ผลเป็นอย่างไร) ให้คนอ่านเข้าใจเนื้อข่าวได้โดยไม่ต้องกดลิงก์\n" +
        "   **ไม่จำกัดความยาว** เขียนยาวได้ตามใจ ใช้สำนวนการเล่าเรื่องของคุณเองได้เต็มที่ " +
        "แบ่งเป็นหลายย่อหน้าได้ถ้าอ่านง่ายกว่า (ขึ้นบรรทัดใหม่ด้วย \\n)\n" +
        "   **ข้อห้ามเดียวที่เด็ดขาด: ห้ามแต่งข้อมูลที่ไม่มีในข้อมูลต้นทางที่ให้มา** " +
        "ห้ามเดาตัวเลข วันเวลา ชื่อคน หรือรายละเอียดเพิ่มเอง — ถ้าข้อมูลต้นทางมีน้อย ก็เขียนเท่าที่มีจริง " +
        "(สั้นแต่จริง ดีกว่ายาวแล้วมั่ว) ขยายความได้เฉพาะการเรียบเรียง/บริบททั่วไปที่ไม่ใช่ข้อเท็จจริงใหม่"
    : "แคปชันสำหรับโพส Facebook เป็นภาษาไทย — สั้น กระชับ 1–2 ประโยค เกริ่นให้น่าสนใจชวนกดลิงก์อ่านต่อ";
}

function topicContext(input: {
  topicName: string;
  aiContext: string | null;
  captionStyle: string | null;
}): string {
  return `## หัวข้อของเพจ
ชื่อหัวข้อ: ${input.topicName}
${input.aiContext ? `เกณฑ์ความเกี่ยวข้อง: ${input.aiContext}` : "เกณฑ์ความเกี่ยวข้อง: ข่าวต้องเกี่ยวกับหัวข้อนี้โดยตรง ไม่ใช่แค่มีคำนี้ปรากฏ"}
${input.captionStyle ? `สไตล์แคปชัน: ${input.captionStyle}` : "สไตล์แคปชัน: โทนเป็นกันเอง อ่านง่าย"}`;
}

function buildBatchPrompt(input: ProcessBatchInput): string {
  const list = input.articles
    .map(
      (a) => `### ข่าว id: ${a.id}
พาดหัว: ${a.title}
${a.source ? `สำนักข่าว: ${a.source}` : ""}
${a.description ? `เนื้อหาย่อ: ${a.description}` : "(ไม่มีเนื้อหาย่อ — ประเมินจากพาดหัว)"}`,
    )
    .join("\n\n");

  return `คุณเป็นบรรณาธิการเพจข่าวภาษาไทย หน้าที่ของคุณคือประเมินข่าวหลายชิ้นว่าแต่ละชิ้นเกี่ยวข้องกับหัวข้อของเพจหรือไม่ และถ้าเกี่ยวข้อง ให้เตรียมเนื้อหาสำหรับโพสลง Facebook

${topicContext(input)}

## ข่าวที่ต้องประเมิน (${input.articles.length} ชิ้น)
${list}

## สิ่งที่ต้องตอบ
ตอบเป็น JSON object ที่มีคีย์ "results" เป็นอาร์เรย์ — **หนึ่งรายการต่อข่าวหนึ่งชิ้น ครบทั้ง ${input.articles.length} ชิ้น**

กฎที่ห้ามผิด:
- **id ในแต่ละรายการต้องตรงกับ id ของข่าวชิ้นนั้น** ประเมินแต่ละชิ้นแยกกันเป็นอิสระ ห้ามเอาเนื้อหาข่าวชิ้นหนึ่งไปปนกับอีกชิ้น
- ห้ามข้ามข่าว และห้ามเพิ่ม id ที่ไม่ได้อยู่ในรายการข้างบน

แต่ละรายการประกอบด้วย:
1. id: id ของข่าวชิ้นนั้น
2. relevant: ข่าวนี้เกี่ยวข้องกับหัวข้อของเพจจริงหรือไม่
3. relevanceScore: คะแนนความเกี่ยวข้องกับหัวข้อ 0 ถึง 1
3.1 interestScore: คะแนน "ความน่าสนใจเชิงข่าว" 0 ถึง 1 — ให้สูงเมื่อเป็นข่าวใหญ่ แปลกใหม่ มีผลกระทบวงกว้าง หรือคนน่าจะอยากอ่าน/แชร์ ให้ต่ำเมื่อเป็นข่าวประกาศทั่วไป ข่าวซ้ำ ๆ หรือรายละเอียดหยุมหยิม (ให้คะแนนแยกจาก relevanceScore — ข่าวตรงหัวข้อมากแต่ไม่น่าสนใจก็มีได้)
4. ถ้า relevant เป็น true ให้ตอบเพิ่ม:
   - summary: สรุปข่าวเป็นภาษาไทย 1–2 ประโยค
   - caption: ${captionInstruction(input.captionIncludeSummary)} — ห้ามใส่ลิงก์และห้ามใส่แฮชแท็กในแคปชัน (ระบบจะแนบให้เอง)
   - hashtags: แฮชแท็กภาษาไทย/อังกฤษ 3–5 อัน (ขึ้นต้นด้วย #)
5. ถ้า relevant เป็น false ให้ summary, caption, hashtags เป็น null`;
}

function buildPrompt(input: ProcessArticleInput): string {
  return `คุณเป็นบรรณาธิการเพจข่าวภาษาไทย หน้าที่ของคุณคือประเมินข่าวหนึ่งชิ้นว่าเกี่ยวข้องกับหัวข้อของเพจหรือไม่ และถ้าเกี่ยวข้อง ให้เตรียมเนื้อหาสำหรับโพสลง Facebook

## หัวข้อของเพจ
ชื่อหัวข้อ: ${input.topicName}
${input.aiContext ? `เกณฑ์ความเกี่ยวข้อง: ${input.aiContext}` : "เกณฑ์ความเกี่ยวข้อง: ข่าวต้องเกี่ยวกับหัวข้อนี้โดยตรง ไม่ใช่แค่มีคำนี้ปรากฏ"}

## ข่าวที่ต้องประเมิน
พาดหัว: ${input.title}
${input.source ? `สำนักข่าว: ${input.source}` : ""}
${input.description ? `เนื้อหาย่อ: ${input.description}` : "(ไม่มีเนื้อหาย่อ — ประเมินจากพาดหัว)"}
${input.content ? `
### เนื้อข่าวเต็มจากเว็บต้นทาง (ใช้อันนี้เป็นแหล่งข้อมูลหลัก)
${input.content}` : ""}

## สิ่งที่ต้องตอบ (JSON)
1. relevant: ข่าวนี้เกี่ยวข้องกับหัวข้อของเพจจริงหรือไม่
2. relevanceScore: คะแนนความเกี่ยวข้องกับหัวข้อ 0 ถึง 1
2.1 interestScore: คะแนน "ความน่าสนใจเชิงข่าว" 0 ถึง 1 — ข่าวใหญ่/แปลกใหม่/มีผลกระทบวงกว้าง = สูง, ข่าวประกาศทั่วไป/หยุมหยิม = ต่ำ (ให้คะแนนแยกจาก relevanceScore)
3. ถ้า relevant เป็น true ให้ตอบเพิ่ม:
   - summary: สรุปข่าวเป็นภาษาไทย 1–2 ประโยค
   - caption: ${captionInstruction(input.captionIncludeSummary)} ${input.captionStyle ? `สไตล์: ${input.captionStyle}` : "โทนเป็นกันเอง อ่านง่าย"} — ห้ามใส่ลิงก์และห้ามใส่แฮชแท็กในแคปชัน (ระบบจะแนบให้เอง)
   - hashtags: แฮชแท็กภาษาไทย/อังกฤษ 3–5 อัน (ขึ้นต้นด้วย #)
4. ถ้า relevant เป็น false ให้ summary, caption, hashtags เป็น null`;
}

export class GeminiProvider implements AiProvider {
  private client: GoogleGenAI;
  /** จำไว้ว่ารุ่นที่ใช้อยู่ไม่รับ thinkingConfig — ครั้งต่อไปจะได้ไม่ต้องเสียคำขอลองใหม่ทุกครั้ง */
  private thinkingUnsupported = false;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  /** ยิง 1 ครั้ง ตามว่าตอนนี้ยังใช้ thinkingConfig ได้อยู่ไหม */
  private callOnce(contents: string, schema: object) {
    return this.client.models.generateContent({
      model: MODEL,
      contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        ...(this.thinkingUnsupported ? GENERATION_CONFIG_NO_THINKING : GENERATION_CONFIG),
      },
    });
  }

  /**
   * ยิง generateContent พร้อมรับมือความไม่แน่นอนของ API สองแบบที่เจอจริง:
   *
   * 1. INVALID_ARGUMENT จาก thinkingConfig — alias "-latest" ถูก Google ขยับรุ่นได้ตลอด
   *    และรุ่นใหม่เคยทำให้ค่าที่เคยใช้ได้ (thinkingBudget: 0) กลายเป็นค่าไม่ถูกต้อง จนระบบล่มทั้งระบบ
   *    เจอแล้วจะจำไว้ แล้วยิงใหม่โดยตัด thinkingConfig ออก (ทำงานต่อได้ แค่คิดนานขึ้น)
   *
   * 2. ตอบกลับว่าง — เกิดเป็นครั้งคราวโดยไม่มีรูปแบบแน่นอน (วัดได้ ~2/5 ครั้งกับชุดเล็ก)
   *    เป็นอาการชั่วคราว ไม่ใช่คำขอผิด จึงลองใหม่ได้ ถ้าไม่ลองใหม่ ข่าว "ทั้งชุด" จะล้มเหลวพร้อมกัน
   *
   * ส่วน MAX_TOKENS ไม่ลองใหม่ เพราะเป็นปัญหาเชิงตั้งค่า (ชุดใหญ่เกิน) — ลองกี่ครั้งก็เหมือนเดิม
   */
  private async generate(contents: string, schema: object) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.callOnce(contents, schema);
        assertNotTruncated(response.candidates?.[0]?.finishReason);
        if (response.text?.trim()) return response;
        lastError = new Error("Gemini ตอบกลับว่าง");
      } catch (err) {
        // รุ่นนี้ไม่รับ thinkingConfig — จำไว้แล้ววนไปยิงใหม่แบบไม่มี thinking ทันที
        if (isInvalidArgument(err) && !this.thinkingUnsupported) {
          this.thinkingUnsupported = true;
          console.warn(
            `[gemini] รุ่น "${MODEL}" ไม่รับ thinkingConfig (budget=${THINKING_BUDGET}) — ` +
              `ยิงใหม่โดยไม่ตั้ง thinking พิจารณาตั้ง GEMINI_THINKING_BUDGET ให้เหมาะกับรุ่นนี้`,
          );
          continue;
        }
        throw err instanceof Error
          ? new Error(`เรียก Gemini รุ่น "${MODEL}" ไม่สำเร็จ: ${err.message}`)
          : err;
      }
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }

    throw new Error(
      `Gemini รุ่น "${MODEL}" ตอบกลับว่างติดต่อกัน ${MAX_ATTEMPTS} ครั้ง — ` +
        `(${lastError instanceof Error ? lastError.message : "ไม่ทราบสาเหตุ"})`,
    );
  }

  async processArticle(input: ProcessArticleInput): Promise<ArticleAssessment> {
    // generate() รับประกันแล้วว่าไม่ว่างและไม่ถูกตัดกลางคัน (ลองใหม่/โยน error ให้เอง)
    const text = (await this.generate(buildPrompt(input), responseSchema)).text!;

    let parsed: {
      relevant?: boolean;
      relevanceScore?: number;
      summary?: string | null;
      caption?: string | null;
      hashtags?: string[] | null;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Gemini ตอบกลับไม่ใช่ JSON: ${text.slice(0, 200)}`);
    }

    return normalizeAssessment(parsed);
  }

  async processArticleBatch(input: ProcessBatchInput): Promise<BatchAssessment[]> {
    if (input.articles.length === 0) return [];

    const text = (await this.generate(buildBatchPrompt(input), batchResponseSchema)).text!;

    let parsed: { results?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Gemini ตอบกลับไม่ใช่ JSON: ${text.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed.results)) {
      throw new Error("Gemini ตอบกลับไม่มีอาร์เรย์ results");
    }

    // รับเฉพาะ id ที่เราส่งไปจริง — กันโมเดลกุ id ขึ้นมาเองแล้วไปเขียนทับข่าวชิ้นอื่น
    const requested = new Set(input.articles.map((a) => a.id));
    const seen = new Set<number>();
    const out: BatchAssessment[] = [];

    for (const raw of parsed.results as Record<string, unknown>[]) {
      const id = Number(raw?.id);
      if (!Number.isInteger(id) || !requested.has(id)) continue;
      if (seen.has(id)) continue; // ตอบ id ซ้ำ — เอาอันแรกพอ
      seen.add(id);
      out.push({ id, ...normalizeAssessment(raw) });
    }

    return out;
  }
}

/** แปลงผลดิบจากโมเดลให้เข้ารูป ArticleAssessment (บีบคะแนนให้อยู่ 0–1, ล้างฟิลด์ของข่าวที่ไม่เกี่ยวข้อง) */
function normalizeAssessment(raw: {
  relevant?: unknown;
  relevanceScore?: unknown;
  interestScore?: unknown;
  summary?: unknown;
  caption?: unknown;
  hashtags?: unknown;
}): ArticleAssessment {
  const relevant = raw.relevant === true;
  const clamp01 = (v: unknown) => Math.min(1, Math.max(0, Number(v ?? 0) || 0));
  return {
    relevant,
    relevanceScore: clamp01(raw.relevanceScore),
    interestScore: clamp01(raw.interestScore),
    summary: relevant ? ((raw.summary as string | null) ?? null) : null,
    caption: relevant ? ((raw.caption as string | null) ?? null) : null,
    hashtags: relevant ? ((raw.hashtags as string[] | null) ?? null) : null,
  };
}

let cached: AiProvider | null = null;

/** provider ตัวที่ระบบใช้อยู่ — จุดเดียวที่ต้องแก้ถ้าสลับเจ้า AI */
export function getAiProvider(): AiProvider {
  if (!cached) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("ยังไม่ได้ตั้งค่า GEMINI_API_KEY ใน .env.local");
    }
    cached = new GeminiProvider(apiKey);
  }
  return cached;
}
