/** ข้อมูลข่าว + บริบทหัวข้อ ที่ส่งให้ AI ประเมิน */
export type ProcessArticleInput = {
  topicName: string;
  /** คำอธิบายว่าข่าวแบบไหน "เกี่ยวข้อง" กับหัวข้อนี้ (จากฟิลด์ aiContext ของ Topic) */
  aiContext: string | null;
  /** โทน/สไตล์แคปชันของหัวข้อนี้ (จากฟิลด์ captionStyle ของ Topic) */
  captionStyle: string | null;
  /** true = ให้แคปชันสรุปเนื้อหาข่าวเต็ม ๆ ในตัว, false = แคปชันสั้นเกริ่นให้กดลิงก์อ่านต่อ */
  captionIncludeSummary?: boolean;
  title: string;
  description: string | null;
  source: string | null;
};

export type ArticleAssessment = {
  relevant: boolean;
  /** 0–1 */
  relevanceScore: number;
  /** สรุปข่าวภาษาไทยสั้น ๆ (เฉพาะข่าวที่เกี่ยวข้อง) */
  summary: string | null;
  /** แคปชันพร้อมโพส ไม่รวมลิงก์ (ลิงก์ต้นทางแนบตอนโพส) */
  caption: string | null;
  hashtags: string[] | null;
};

/** ข่าวหนึ่งชิ้นในชุด (batch) — ต้องมี id เพื่อจับผลลัพธ์กลับให้ถูกชิ้น */
export type BatchArticleInput = {
  id: number;
  title: string;
  description: string | null;
  source: string | null;
};

/**
 * ชุดข่าวที่ส่งประเมินพร้อมกันใน request เดียว
 * ทุกชิ้นต้องมาจากหัวข้อเดียวกัน เพราะบริบท (topicName/aiContext/captionStyle) ส่งครั้งเดียวต่อชุด
 */
export type ProcessBatchInput = {
  topicName: string;
  aiContext: string | null;
  captionStyle: string | null;
  /** true = ให้แคปชันสรุปเนื้อหาข่าวเต็ม ๆ ในตัว, false = แคปชันสั้นเกริ่นให้กดลิงก์อ่านต่อ */
  captionIncludeSummary?: boolean;
  articles: BatchArticleInput[];
};

/** ผลประเมินของข่าวหนึ่งชิ้นในชุด — id ต้องตรงกับที่ส่งไป */
export type BatchAssessment = ArticleAssessment & { id: number };

/**
 * Interface กลางของผู้ให้บริการ AI — implement ใหม่ตัวเดียวถ้าจะสลับเจ้า
 * (ปัจจุบันใช้ Gemini — ดู gemini.ts)
 */
export interface AiProvider {
  /** ประเมินทีละชิ้น — ใช้กับปุ่ม "ประมวลผลใหม่" รายข่าว */
  processArticle(input: ProcessArticleInput): Promise<ArticleAssessment>;

  /**
   * ประเมินหลายชิ้นใน request เดียว — ใช้กับการประมวลผลข่าวค้างจำนวนมาก
   * เพื่อประหยัดโควตา (RPD/RPM) และลดเวลารวมอย่างมาก
   *
   * ผู้ implement ไม่จำเป็นต้องคืนครบทุก id — ตัวเรียก (processor) จะถือว่า
   * id ที่ขาดหายไปคือ "ประเมินไม่สำเร็จ" แล้วคงสถานะเดิมไว้ให้ลองใหม่
   */
  processArticleBatch(input: ProcessBatchInput): Promise<BatchAssessment[]>;
}
