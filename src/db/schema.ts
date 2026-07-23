import {
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * สิทธิ์ของบัญชี — admin คือ "super admin" ผู้ดูแลระบบ (บัญชีแรกที่สมัครได้ไปอัตโนมัติ)
 * เก็บเป็นคอลัมน์แทนการเดาจาก id น้อยสุด เพราะถ้าลบบัญชีแรกทิ้ง คนอื่นจะกลายเป็น admin เองโดยไม่ตั้งใจ
 */
export type UserRole = "admin" | "user";

/**
 * สถานะการใช้งานของบัญชี
 * - pending: สมัครแล้วแต่ยังใช้งานไม่ได้ รอ admin อนุมัติ (ค่าเริ่มต้นของบัญชีใหม่)
 * - active:  ใช้งานได้ (ยังต้องดู accessExpiresAt ประกอบ)
 * - revoked: ถูกเพิกถอนสิทธิ์
 */
export type UserStatus = "pending" | "active" | "revoked";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  role: text("role").$type<UserRole>().notNull().default("user"),
  status: text("status").$type<UserStatus>().notNull().default("pending"),
  /** วันหมดอายุสิทธิ์ใช้งาน — null = ใช้ได้ไม่มีกำหนด (ใช้กับ status active เท่านั้น) */
  accessExpiresAt: integer("access_expires_at", { mode: "timestamp_ms" }),
  /**
   * อีเมลติดต่อ — เก็บเป็นตัวพิมพ์เล็กเสมอ (normalizeEmail) เพื่อให้ unique กันซ้ำได้จริง
   *
   * null ได้ เพราะบัญชีที่สมัครก่อนมีระบบอีเมลยังไม่มีค่า (SQLite ยอมให้ NULL ซ้ำกันได้
   * ใน unique index จึงไม่ชนกัน) — บัญชีใหม่บังคับกรอกตั้งแต่หน้าสมัคร
   */
  email: text("email").unique(),
  /** รูปแบบ scrypt: "<salt hex>.<hash hex>" */
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const sessions = sqliteTable("sessions", {
  /** opaque random id (hex) — เก็บใน DB เพื่อให้เพิกถอน session รายอันได้ */
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** นับความพยายามล็อกอินที่ล้มเหลวต่อ identifier (เช่น IP) สำหรับ rate limit — DB-backed ให้ทำงานถูกบน serverless */
export const authAttempts = sqliteTable("auth_attempts", {
  identifier: text("identifier").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
});

/**
 * แหล่งข่าวที่หัวข้อนี้จะดึง — คุมผ่าน "ฉบับ" (edition) ของ Google News
 * - auto: เดาจากภาษาของ keyword (ไทย -> ฉบับไทย, อังกฤษ -> ฉบับสหรัฐฯ) = พฤติกรรมเดิม
 * - th:   บังคับฉบับไทยทุก keyword
 * - intl: บังคับฉบับสหรัฐฯ/อังกฤษทุก keyword
 * - both: ดึงทั้งสองฉบับ แล้วรวมผล (กันซ้ำด้วยกลไกเดิม)
 */
export type NewsSource = "auto" | "th" | "intl" | "both";

export const topics = sqliteTable("topics", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** เจ้าของหัวข้อ — null ได้เฉพาะข้อมูลเก่าก่อนมีระบบบัญชี (บัญชีแรกที่สมัครจะรับไปเป็นเจ้าของ) */
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keywords: text("keywords", { mode: "json" }).$type<string[]>().notNull(),
  aiContext: text("ai_context"),
  captionStyle: text("caption_style"),
  /*
   * เคยมี captionIncludeSummary ตรงนี้ — สวิตช์ต่อหัวข้อว่าให้แคปชันเล่าเนื้อข่าวเต็มไหม
   * ถอดออกเพราะมันสั่งให้ AI "เขียนยาวไม่จำกัด" จากวัตถุดิบที่มีแค่พาดหัว + เนื้อย่อ RSS
   * ซึ่งคือการเชิญชวนให้แต่งเติมโดยตรง ความยาวตัดสินจากการมีเนื้อข่าวจริงแทน
   * (ดู captionInstruction ใน src/lib/ai/gemini.ts)
   */
  /** แหล่งข่าวที่จะดึง (ดู NewsSource) — default auto = พฤติกรรมเดิมก่อนมีตัวเลือกนี้ */
  newsSource: text("news_source").$type<NewsSource>().notNull().default("auto"),
  fbPageId: text("fb_page_id"),
  /** Page Access Token ของเพจปลายทาง — secret ต่อหัวข้อ ห้ามส่งกลับไป client (ดู topic DTO) */
  fbPageToken: text("fb_page_token"),
  cronSchedule: text("cron_schedule").notNull().default("0 7 * * *"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** ชนิดการกระทำของผู้ดูแลระบบที่บันทึกลง audit log */
export type AdminAction =
  | "promote_admin" // เลื่อนขั้นเป็นผู้ดูแลระบบ
  | "demote_user" // ลดขั้นเป็นผู้ใช้ทั่วไป
  | "set_status" // เปลี่ยนสถานะบัญชี (อนุมัติ/เพิกถอน)
  | "set_access_expiry" // ตั้ง/ล้างวันหมดอายุสิทธิ์
  | "reset_password"; // ตั้งรหัสผ่านใหม่ให้บัญชีอื่น

/**
 * ผลของการกระทำ
 * - success: ทำสำเร็จ (มีการเปลี่ยนข้อมูลจริง)
 * - denied: ถูกปฏิเสธเพราะไม่มีสิทธิ์ — บันทึกไว้เพื่อจับความพยายามข้ามสิทธิ์ (สัญญาณบุกรุก)
 */
export type AuditOutcome = "success" | "denied";

/**
 * บันทึกการกระทำของผู้ดูแลระบบต่อบัญชีคนอื่น — ใครทำอะไรกับใครเมื่อไหร่
 *
 * เก็บ username เป็น snapshot คู่กับ FK เพราะต้องการให้บันทึกอ่านรู้เรื่องแม้บัญชีถูกลบไปแล้ว
 * (FK ตั้ง onDelete: set null เพื่อไม่ให้การลบผู้ใช้ทำให้ประวัติหาย — ประวัติต้องอยู่ต่อ)
 * summary เป็นข้อความไทยสำเร็จรูป เพื่อให้ความหมายคงอยู่แม้ enum action จะเปลี่ยนในอนาคต
 */
export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorId: integer("actor_id").references(() => users.id, { onDelete: "set null" }),
  actorUsername: text("actor_username").notNull(),
  targetId: integer("target_id").references(() => users.id, { onDelete: "set null" }),
  targetUsername: text("target_username").notNull(),
  action: text("action").$type<AdminAction>().notNull(),
  /** success = ทำจริง, denied = ถูกปฏิเสธเพราะไม่มีสิทธิ์ (default success เพื่อ backward-compat) */
  outcome: text("outcome").$type<AuditOutcome>().notNull().default("success"),
  summary: text("summary").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type ArticleStatus =
  | "fetched" // ดึงเข้ามาแล้ว รอ AI ประมวลผล
  | "irrelevant" // AI ตัดสินว่าไม่เกี่ยวข้องกับหัวข้อ
  | "draft" // AI ร่างแคปชันแล้ว รอแอดมินตรวจ
  | "draft_long" // ร่างที่ AI ไปอ่านเนื้อข่าวจากเว็บจริงแล้วเขียนแคปชันยาว (ดู src/lib/long-form.ts)
  | "approved"
  | "scheduled"
  | "posted"
  | "rejected"
  | "failed";

export const articles = sqliteTable(
  "articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** ลิงก์จาก Google News RSS — เป็นลิงก์ redirect ของ google ไม่ใช่ลิงก์เว็บข่าวจริง */
    url: text("url").notNull(),
    /**
     * ลิงก์เว็บข่าวจริงที่แกะออกมาจาก url (cache — แกะครั้งเดียวพอ)
     *
     * ต้องมีเพราะ Facebook ดูด og tag จากลิงก์ google แล้วได้ "Google News" + โลโก้ google
     * ทุกโพสต์เลยหน้าตาเหมือนกันหมด ไม่เห็นพาดหัวหรือรูปข่าวจริง
     * null = ยังไม่ได้แกะ หรือแกะไม่สำเร็จ (ระบบจะถอยไปใช้ url เดิม)
     */
    resolvedUrl: text("resolved_url"),
    source: text("source"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    description: text("description"),
    imageUrl: text("image_url"),
    status: text("status").$type<ArticleStatus>().notNull().default("fetched"),
    relevanceScore: real("relevance_score"),
    /**
     * คะแนน "ความน่าสนใจของข่าว" 0–1 ที่ AI ให้ตอนคัดกรอง — คนละเรื่องกับ relevanceScore
     *
     * relevanceScore = เกี่ยวกับหัวข้อแค่ไหน (ข่าวเล็ก ๆ ที่ตรงหัวข้อเป๊ะก็ได้คะแนนสูง)
     * interestScore  = น่าสนใจ/มีผลกระทบแค่ไหนในเชิงข่าว (ข่าวใหญ่ แปลกใหม่ มีผลวงกว้าง)
     * ใช้จัดอันดับว่าข่าวไหนคุ้มที่จะไปดึงเนื้อจากเว็บจริงมาเขียนแคปชันแบบยาว
     */
    interestScore: real("interest_score"),
    /**
     * เนื้อข่าวจริงที่ดึงมาจากหน้าเว็บสำนักข่าว (cache)
     *
     * มีค่า = เคยดึงสำเร็จและเขียนแคปชันแบบยาวไปแล้ว ใช้เป็นเครื่องหมายกันเลือกซ้ำ
     * และทำให้สั่งเขียนใหม่ได้โดยไม่ต้องไปรบกวนเว็บต้นทางอีก
     */
    content: text("content"),
    /**
     * ครั้งล่าสุดที่พยายามเขียนแคปชันยาวให้ข่าวนี้แล้วไม่สำเร็จ
     *
     * มีไว้เพื่อ "เลื่อนไปท้ายแถว" ไม่ใช่เพื่อตัดสิทธิ์ — เว็บที่บล็อกบอทหรือ 404
     * มักมีคะแนนความน่าสนใจสูง จึงลอยขึ้นหัวคิวมาขวางทุกครั้งที่กดปุ่ม
     * เรียงด้วย coalesce(ค่านี้, 0) จากน้อยไปมาก แปลว่า:
     *   ยังไม่เคยพัง (0) มาก่อน → เคยพังนานแล้ว → เพิ่งพังเมื่อกี้ อยู่ท้ายสุด
     * ล้างทิ้งเมื่อเขียนสำเร็จ เพราะเว็บอาจกลับมาใช้ได้แล้ว
     */
    longFormFailedAt: integer("long_form_failed_at", { mode: "timestamp_ms" }),
    summary: text("summary"),
    caption: text("caption"),
    hashtags: text("hashtags", { mode: "json" }).$type<string[]>(),
    fbPostId: text("fb_post_id"),
    fbPostUrl: text("fb_post_url"),
    postedAt: integer("posted_at", { mode: "timestamp_ms" }),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("articles_topic_url_unique").on(t.topicId, t.url)],
);

/**
 * ข่าวที่ผู้ใช้ลบทิ้ง — จำ URL/หัวข้อไว้เพื่อไม่ให้รอบดึงถัดไปเก็บกลับเข้ามาอีก
 *
 * ทำไมต้องมีตารางนี้: ตัวกันซ้ำของ articles คือ unique(topicId, url) ซึ่งอยู่ได้
 * เพราะแถวยังอยู่ พอลบแถวทิ้ง กุญแจก็หายไปด้วย ข่าวเดิมที่ยังอยู่ในฟีด RSS
 * จึงถูกดึงกลับมาใหม่ได้ ตารางนี้คือ "ความจำ" ที่อยู่ต่อหลังลบ
 *
 * เก็บ titleKey ด้วย เพราะตัวดึงกันซ้ำจากทั้ง URL และหัวข้อที่ normalize แล้ว
 * (ข่าวเดียวกันมาจากคนละสำนัก = คนละ URL) ถ้าบล็อกแค่ URL ข่าวเดิมจะกลับมาทาง URL อื่นได้
 */
export const blockedArticles = sqliteTable(
  "blocked_articles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** หัวข้อข่าวที่ normalize แล้ว (ตรงกับ normalizeTitle ใน src/lib/normalize.ts) */
    titleKey: text("title_key").notNull(),
    /** เก็บหัวข้อดิบไว้โชว์ในหน้า "รายการที่บล็อกไว้" ให้คนอ่านรู้เรื่อง */
    title: text("title").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("blocked_articles_topic_url_unique").on(t.topicId, t.url)],
);

/**
 * สถิติการเรียก AI ทีละครั้ง — ไว้ดูว่าการต่อ AI กำลังเสื่อมก่อนที่จะพังสนิท
 *
 * ทำไมต้องมี: เหตุการณ์ 23 ก.ค. 2569 (ดู docs/POSTMORTEM-2026-07-23-*) ฟีเจอร์ AI ล่ม 100%
 * โดยไม่มีใครรู้จนผู้ใช้มาแจ้ง และก่อนล่มจริงมีสัญญาณเตือนที่มองไม่เห็นคือ
 * "ขอ 10 ข่าว ได้กลับมา 1" กับเวลาที่พุ่งจาก 4 เป็น 30 วินาที
 *
 * requested/returned จึงสำคัญกว่าแค่ ok/ไม่ ok — เพราะการเสื่อมแบบ "สำเร็จแต่ไม่ครบ"
 * ไม่ throw error ใด ๆ ถ้าเก็บแค่สำเร็จ/ล้มเหลวจะมองไม่เห็นเลย
 */
export const aiCallLogs = sqliteTable("ai_call_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** null ได้เมื่อหัวข้อถูกลบ — สถิติต้องอยู่ต่อเพื่อดูแนวโน้มย้อนหลัง */
  topicId: integer("topic_id").references(() => topics.id, { onDelete: "set null" }),
  /** snapshot ชื่อหัวข้อ ให้อ่านรู้เรื่องแม้หัวข้อถูกลบไปแล้ว */
  topicName: text("topic_name").notNull(),
  /** ชื่อรุ่นที่ตั้งไว้ตอนเรียก — ถ้าเปลี่ยนรุ่นแล้วสถิติแย่ลง จะเห็นความสัมพันธ์ทันที */
  model: text("model").notNull(),
  /** batch = ชุดหลายข่าว, single = ประมวลผลซ้ำทีละข่าว */
  mode: text("mode").$type<"batch" | "single">().notNull(),
  /** จำนวนข่าวที่ส่งไป */
  requested: integer("requested").notNull(),
  /** จำนวนผลที่ได้กลับมาใช้ได้จริง — น้อยกว่า requested = สัญญาณเสื่อม */
  returned: integer("returned").notNull(),
  durationMs: integer("duration_ms").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const fetchRuns = sqliteTable("fetch_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  topicId: integer("topic_id")
    .notNull()
    .references(() => topics.id, { onDelete: "cascade" }),
  trigger: text("trigger").$type<"schedule" | "manual">().notNull(),
  status: text("status")
    .$type<"running" | "done" | "failed">()
    .notNull()
    .default("running"),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  found: integer("found").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  /** ข่าวที่ข้ามเพราะผู้ใช้เคยลบทิ้ง (อยู่ใน blocked_articles) */
  blocked: integer("blocked").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  errorMessage: text("error_message"),
});

export type User = typeof users.$inferSelect;
export type AdminAuditEntry = typeof adminAuditLog.$inferSelect;
export type NewAdminAuditEntry = typeof adminAuditLog.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Topic = typeof topics.$inferSelect;
export type Article = typeof articles.$inferSelect;
export type BlockedArticle = typeof blockedArticles.$inferSelect;
export type FetchRun = typeof fetchRuns.$inferSelect;
export type AiCallLog = typeof aiCallLogs.$inferSelect;
export type NewAiCallLog = typeof aiCallLogs.$inferInsert;
