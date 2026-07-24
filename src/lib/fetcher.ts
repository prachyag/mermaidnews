import { and, eq, gt, inArray } from "drizzle-orm";
import Parser from "rss-parser";
import { db } from "@/db";
import { articles, blockedArticles, fetchRuns, topics, type Topic } from "@/db/schema";
import { normalizeTitle, normalizeUrl } from "@/lib/normalize";
import { buildFeedUrl, editionsFor } from "@/lib/editions";
import { DEFAULT_FETCH_DAYS } from "@/lib/fetch-window";

type FeedItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  contentSnippet?: string;
  // <source url="...">ชื่อสำนักข่าว</source> จาก Google News RSS
  source?: string | { _?: string; $?: { url?: string } };
};

const parser = new Parser<Record<string, unknown>, FeedItem>({
  customFields: { item: ["source"] },
  timeout: 20_000,
});

/** ถ้ารอบดึงค้างสถานะ running นานเกินนี้ ถือว่าตายแล้ว ไม่นับเป็น lock */
const LOCK_TTL_MS = 5 * 60 * 1000;
/** จำกัดจำนวนข่าวต่อ keyword ต่อรอบ กัน keyword กว้างเกิน */
const MAX_ITEMS_PER_KEYWORD = 50;


function extractSourceName(item: FeedItem): string | null {
  if (!item.source) return null;
  if (typeof item.source === "string") return item.source;
  return item.source._ ?? null;
}

/** Google News ใช้หัวข้อรูปแบบ "พาดหัว - สำนักข่าว" — ตัดชื่อสำนักข่าวท้ายออก */
function cleanTitle(title: string, sourceName: string | null): string {
  if (sourceName && title.endsWith(` - ${sourceName}`)) {
    return title.slice(0, -(` - ${sourceName}`.length)).trim();
  }
  return title.trim();
}

export type StartResult =
  | { started: true; runId: number; topicId: number; topicName: string }
  | { started: false; reason: "locked" | "disabled"; topicId: number; topicName: string };

/**
 * ขอ lock การดึงของหัวข้อ (สร้างแถว FetchRun สถานะ running)
 * คืน runId ถ้าได้ lock — ตัวดึงจริงต้องเรียก executeFetchRun ต่อ
 */
export async function acquireFetchRun(
  topic: Topic,
  trigger: "manual" | "schedule",
): Promise<StartResult> {
  if (!topic.enabled) {
    return { started: false, reason: "disabled", topicId: topic.id, topicName: topic.name };
  }
  const staleCutoff = new Date(Date.now() - LOCK_TTL_MS);
  const running = await db.query.fetchRuns.findFirst({
    where: and(
      eq(fetchRuns.topicId, topic.id),
      eq(fetchRuns.status, "running"),
      gt(fetchRuns.startedAt, staleCutoff),
    ),
  });
  if (running) {
    return { started: false, reason: "locked", topicId: topic.id, topicName: topic.name };
  }
  const [run] = await db
    .insert(fetchRuns)
    .values({ topicId: topic.id, trigger })
    .returning();
  return { started: true, runId: run.id, topicId: topic.id, topicName: topic.name };
}

/**
 * ดึงข่าวจริงของหนึ่งรอบ (ต้องได้ runId จาก acquireFetchRun มาก่อน)
 *
 * days = ดึงข่าวย้อนหลังกี่วัน (ดู src/lib/fetch-window.ts) — ไม่ระบุใช้ค่าเริ่มต้น
 * ไม่เก็บลง fetch_runs เพราะยังไม่มีที่ไหนต้องอ่านย้อนหลัง และการเพิ่มคอลัมน์
 * แปลว่าต้องไป ALTER TABLE บน production ด้วยมืออีกรอบ (ดู DEPLOY.md 2b)
 */
export async function executeFetchRun(
  runId: number,
  topic: Topic,
  days: number = DEFAULT_FETCH_DAYS,
): Promise<void> {
  let found = 0;
  let newCount = 0;
  let duplicates = 0;
  let blocked = 0;
  let errorCount = 0;
  const errorMessages: string[] = [];

  try {
    // หัวข้อข่าวที่มีอยู่แล้วของ topic นี้ ใช้กันข่าวเดียวกันจากคนละ URL
    const existing = await db
      .select({ title: articles.title, url: articles.url })
      .from(articles)
      .where(eq(articles.topicId, topic.id));
    const knownTitles = new Set(existing.map((a) => normalizeTitle(a.title)));
    const knownUrls = new Set(existing.map((a) => a.url));

    // ข่าวที่ผู้ใช้ลบทิ้ง — ต้องไม่ถูกดึงกลับเข้ามาอีก
    const blockedRows = await db
      .select({ url: blockedArticles.url, titleKey: blockedArticles.titleKey })
      .from(blockedArticles)
      .where(eq(blockedArticles.topicId, topic.id));
    const blockedUrls = new Set(blockedRows.map((b) => b.url));
    const blockedTitles = new Set(blockedRows.map((b) => b.titleKey));

    // keyword × ฉบับ — ถ้าตั้งเป็น "both" หนึ่ง keyword จะยิง 2 ฉบับ
    const jobs = topic.keywords.flatMap((keyword) =>
      editionsFor(keyword, topic.newsSource).map((edition) => ({ keyword, edition })),
    );

    for (const { keyword, edition } of jobs) {
      try {
        const feed = await parser.parseURL(buildFeedUrl(keyword, edition, days));
        const items = (feed.items ?? []).slice(0, MAX_ITEMS_PER_KEYWORD);
        found += items.length;

        for (const item of items) {
          if (!item.title || !item.link) continue;
          const url = normalizeUrl(item.link);
          const sourceName = extractSourceName(item);
          const title = cleanTitle(item.title, sourceName);
          const titleKey = normalizeTitle(title);

          // เช็คบล็อกก่อนเสมอ — ข่าวที่ผู้ใช้ลบทิ้งต้องไม่กลับมาไม่ว่าทางไหน
          if (blockedUrls.has(url) || blockedTitles.has(titleKey)) {
            blocked++;
            continue;
          }

          if (knownUrls.has(url) || knownTitles.has(titleKey)) {
            duplicates++;
            continue;
          }

          const inserted = await db
            .insert(articles)
            .values({
              topicId: topic.id,
              title,
              url,
              source: sourceName,
              publishedAt: item.pubDate ? new Date(item.pubDate) : null,
              description: item.contentSnippet?.slice(0, 2000) ?? null,
            })
            .onConflictDoNothing()
            .returning({ id: articles.id });

          if (inserted.length > 0) {
            newCount++;
            knownUrls.add(url);
            knownTitles.add(titleKey);
          } else {
            duplicates++;
          }
        }
      } catch (err) {
        errorCount++;
        errorMessages.push(
          `keyword "${keyword}" (${edition}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await db
      .update(fetchRuns)
      .set({
        status: errorCount > 0 && found === 0 ? "failed" : "done",
        finishedAt: new Date(),
        found,
        newCount,
        duplicates,
        blocked,
        errorCount,
        errorMessage: errorMessages.length > 0 ? errorMessages.join(" | ") : null,
      })
      .where(eq(fetchRuns.id, runId));
  } catch (err) {
    await db
      .update(fetchRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        found,
        newCount,
        duplicates,
        blocked,
        errorCount: errorCount + 1,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .where(eq(fetchRuns.id, runId));
  }
}

/**
 * เริ่มรอบดึงให้หลายหัวข้อ: ขอ lock ทุกหัวข้อก่อน แล้วคืนรายการที่ได้เริ่มจริง
 * userId: จำกัดเฉพาะหัวข้อของ user นั้น (undefined = ทุก user — สำหรับ cron ระบบ)
 */
export async function startFetch(
  topicIds: number[] | "all",
  trigger: "manual" | "schedule",
  userId?: number,
): Promise<{ results: StartResult[]; targets: { runId: number; topic: Topic }[] }> {
  const ownedBy = userId !== undefined ? eq(topics.userId, userId) : undefined;
  const targetTopics =
    topicIds === "all"
      ? await db.query.topics.findMany({
          where: ownedBy ? and(eq(topics.enabled, true), ownedBy) : eq(topics.enabled, true),
        })
      : await db.query.topics.findMany({
          where: ownedBy
            ? and(inArray(topics.id, topicIds), ownedBy)
            : inArray(topics.id, topicIds),
        });

  const results: StartResult[] = [];
  const targets: { runId: number; topic: Topic }[] = [];
  for (const topic of targetTopics) {
    const result = await acquireFetchRun(topic, trigger);
    results.push(result);
    if (result.started) targets.push({ runId: result.runId, topic });
  }
  return { results, targets };
}
