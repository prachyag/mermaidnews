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

/**
 * ตั้งค่าที่ใช้ร่วมกันทุก request — สองบรรทัดนี้สำคัญมาก วัดผลกับ API จริงแล้ว:
 *
 * thinkingBudget: 0 — ปิดโหมด "คิดก่อนตอบ" ของ Gemini 2.5 Flash
 *   งานนี้เป็นการคัดกรอง+เขียนแคปชันสั้น ๆ ไม่ต้องใช้การให้เหตุผลหลายขั้น
 *   แต่ถ้าเปิดไว้ (ค่า default) โมเดลคิดยาวมากกับ prompt ที่มีกฎเยอะ:
 *   วัดได้ 124 วินาที/ชุด และ thinking token กินโควตา output จน JSON ถูกตัดกลางคัน
 *
 * maxOutputTokens — กันผลลัพธ์ถูกตัดเงียบ ๆ เมื่อชุดใหญ่ (ข้อความไทยกิน token เยอะ)
 */
const GENERATION_CONFIG = {
  temperature: 0.4,
  thinkingConfig: { thinkingBudget: 0 },
  maxOutputTokens: 8192,
} as const;

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
    summary: { type: Type.STRING, nullable: true },
    caption: { type: Type.STRING, nullable: true },
    hashtags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      nullable: true,
    },
  },
  required: ["relevant", "relevanceScore"],
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
          summary: { type: Type.STRING, nullable: true },
          caption: { type: Type.STRING, nullable: true },
          hashtags: { type: Type.ARRAY, items: { type: Type.STRING }, nullable: true },
        },
        required: ["id", "relevant", "relevanceScore"],
      },
    },
  },
  required: ["results"],
} as const;

/** ส่วนบรรยายงานที่เหมือนกันทั้งแบบเดี่ยวและแบบชุด — ส่งครั้งเดียวต่อชุดคือที่มาของการประหยัด token */
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
3. relevanceScore: คะแนนความเกี่ยวข้อง 0 ถึง 1
4. ถ้า relevant เป็น true ให้ตอบเพิ่ม:
   - summary: สรุปข่าวเป็นภาษาไทย 1–2 ประโยค
   - caption: แคปชันสำหรับโพส Facebook เป็นภาษาไทย — ห้ามใส่ลิงก์และห้ามใส่แฮชแท็กในแคปชัน (ระบบจะแนบให้เอง)
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

## สิ่งที่ต้องตอบ (JSON)
1. relevant: ข่าวนี้เกี่ยวข้องกับหัวข้อของเพจจริงหรือไม่
2. relevanceScore: คะแนนความเกี่ยวข้อง 0 ถึง 1
3. ถ้า relevant เป็น true ให้ตอบเพิ่ม:
   - summary: สรุปข่าวเป็นภาษาไทย 1–2 ประโยค
   - caption: แคปชันสำหรับโพส Facebook เป็นภาษาไทย ${input.captionStyle ? `สไตล์: ${input.captionStyle}` : "โทนเป็นกันเอง อ่านง่าย"} — ห้ามใส่ลิงก์และห้ามใส่แฮชแท็กในแคปชัน (ระบบจะแนบให้เอง)
   - hashtags: แฮชแท็กภาษาไทย/อังกฤษ 3–5 อัน (ขึ้นต้นด้วย #)
4. ถ้า relevant เป็น false ให้ summary, caption, hashtags เป็น null`;
}

export class GeminiProvider implements AiProvider {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async processArticle(input: ProcessArticleInput): Promise<ArticleAssessment> {
    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: buildPrompt(input),
      config: {
        responseMimeType: "application/json",
        responseSchema,
        ...GENERATION_CONFIG,
      },
    });

    assertNotTruncated(response.candidates?.[0]?.finishReason);
    const text = response.text;
    if (!text) throw new Error("Gemini ตอบกลับว่าง");

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

    const response = await this.client.models.generateContent({
      model: MODEL,
      contents: buildBatchPrompt(input),
      config: {
        responseMimeType: "application/json",
        responseSchema: batchResponseSchema,
        ...GENERATION_CONFIG,
      },
    });

    assertNotTruncated(response.candidates?.[0]?.finishReason);
    const text = response.text;
    if (!text) throw new Error("Gemini ตอบกลับว่าง");

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
  summary?: unknown;
  caption?: unknown;
  hashtags?: unknown;
}): ArticleAssessment {
  const relevant = raw.relevant === true;
  return {
    relevant,
    relevanceScore: Math.min(1, Math.max(0, Number(raw.relevanceScore ?? 0) || 0)),
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
