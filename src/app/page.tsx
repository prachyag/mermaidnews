"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArticleCard, type ArticleRow } from "@/components/ArticleCard";
import { STATUS_META, STATUS_ORDER, statusLabel } from "@/lib/article-status";
import type { ArticleCounts } from "@/lib/article-counts";
import { MAX_REPROCESS, REPROCESSABLE } from "@/lib/reprocess-policy";
import { MAX_LONG_FORM } from "@/lib/long-form-policy";
import { FETCH_WINDOW_PRESETS, fetchWindowLabel } from "@/lib/fetch-window";

type Topic = {
  id: number;
  name: string;
  keywords: string[];
  enabled: boolean;
};

type RunRow = {
  id: number;
  topicId: number;
  topicName: string;
  trigger: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt: string | null;
  found: number;
  newCount: number;
  duplicates: number;
  errorCount: number;
  errorMessage: string | null;
};

/**
 * แท็บกรองสถานะ เรียงตามเส้นทางการทำงานจริง (ดึง -> AI ร่าง -> อนุมัติ -> โพส)
 * ต่อท้ายด้วยสถานะปลายทางที่ไม่ได้ไปต่อ — ดูลำดับที่ src/lib/article-status.ts
 */
const STATUS_TABS: { value: string; label: string; dot: string | null }[] = [
  { value: "all", label: "ทั้งหมด", dot: null },
  ...STATUS_ORDER.map((s) => ({
    value: s as string,
    label: STATUS_META[s].short,
    dot: STATUS_META[s].dot,
  })),
];

const EMPTY_COUNTS = { all: 0 } as ArticleCounts;

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * ยิง POST แล้วคืนผล — **รับประกันว่าไม่ throw**
 *
 * เมื่อฟังก์ชันบน Vercel ถูกตัดเพราะหมดเวลา (FUNCTION_INVOCATION_TIMEOUT) สิ่งที่ได้กลับมา
 * คือหน้า HTML ของ Vercel ไม่ใช่ JSON — `res.json()` จึงโยน error ออกมา
 * ถ้าไม่ดัก error จะทะลุออกจากตัวจัดการทั้งก้อน โค้ดสรุปผลท้ายฟังก์ชันไม่ได้ทำงาน
 * และหน้าจอค้างอยู่ที่ข้อความ "กำลังทำ..." ตลอดไปโดยผู้ใช้ไม่รู้ว่าเลิกไปแล้ว (เกิดจริงมาแล้ว)
 */
async function postJson<T>(url: string, body: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "ติดต่อเซิร์ฟเวอร์ไม่ได้ — ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่" };
  }

  // อ่านเป็นข้อความก่อนเสมอ แล้วค่อยลอง parse — body อาจไม่ใช่ JSON และอาจว่างเปล่า
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // ไม่ใช่ JSON (หน้า error ของแพลตฟอร์ม) — ใช้ status เป็นตัวบอกเหตุแทน
  }
  const error = (data as { error?: string } | null)?.error;

  if (res.ok) return { ok: true, data: (data ?? {}) as T };
  return { ok: false, error: error ?? httpReason(res.status) };
}

/** แปลง HTTP status เป็นเหตุผลที่ผู้ใช้อ่านแล้วรู้ว่าต้องทำอะไรต่อ */
function httpReason(status: number): string {
  if (status === 504 || status === 502)
    return "เซิร์ฟเวอร์ใช้เวลานานเกินกำหนดจนถูกตัด (งานอาจทำสำเร็จไปบางส่วนแล้ว)";
  if (status === 401) return "เซสชันหมดอายุ — เข้าสู่ระบบใหม่";
  if (status === 413) return "ข้อมูลที่ส่งใหญ่เกินไป";
  return `เซิร์ฟเวอร์ตอบกลับ HTTP ${status}`;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function Home() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [articleRows, setArticleRows] = useState<ArticleRow[]>([]);
  const [counts, setCounts] = useState<ArticleCounts>(EMPTY_COUNTS);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [fetching, setFetching] = useState(false);
  const [fetchPromptOpen, setFetchPromptOpen] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [longForming, setLongForming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loadingArticles, setLoadingArticles] = useState(true);
  const batchRunIds = useRef<number[]>([]);
  /** ยกเลิกคำขอโหลดข่าวอันก่อนเมื่อมีอันใหม่ */
  const abortRef = useRef<AbortController | null>(null);
  /** เลขลำดับคำขอ — ใช้ทิ้งผลของคำขอเก่าที่มาช้ากว่า */
  const requestSeq = useRef(0);
  /** หัวข้อที่นับยอดไว้ล่าสุด — ใช้ตัดสินว่าต้องนับใหม่ไหม */
  const countedTopic = useRef<string | null>(null);

  const loadTopics = useCallback(async () => {
    const res = await fetch("/api/topics");
    const data = await res.json();
    setTopics(data.topics ?? []);
  }, []);

  /**
   * โหลดรายการข่าว
   *
   * withCounts=false เมื่อเปลี่ยนแค่แท็บ — ยอดแต่ละสถานะเท่ากันหมดทุกแท็บอยู่แล้ว
   * ไม่ต้องให้เซิร์ฟเวอร์นับใหม่ (ประหยัดการเดินทางไปฐานข้อมูล 1 รอบ ~130ms)
   *
   * กันคำตอบสลับลำดับ 2 ชั้น: ยกเลิกคำขอเก่าด้วย AbortController และเทียบเลขลำดับ
   * ก่อนเขียน state — ถ้ากดแท็บรัว ๆ คำตอบของแท็บเก่าที่มาช้าจะต้องไม่เขียนทับแท็บปัจจุบัน
   */
  const loadArticles = useCallback(
    async (topicId: string, status: string, { withCounts = true } = {}) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++requestSeq.current;

      setLoadingArticles(true);
      try {
        const res = await fetch(
          `/api/articles?topicId=${topicId}&status=${status}${withCounts ? "" : "&counts=0"}`,
          { signal: controller.signal },
        );
        const data = await res.json();
        if (seq !== requestSeq.current) return; // มีคำขอใหม่กว่าแซงไปแล้ว — ทิ้งผลนี้
        setArticleRows(data.articles ?? []);
        if (data.counts) setCounts(data.counts);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // ตั้งใจยกเลิกเอง ไม่ใช่ error
        if (seq === requestSeq.current) setMessage("❌ โหลดรายการข่าวไม่สำเร็จ");
      } finally {
        // เคลียร์สถานะกำลังโหลดเฉพาะเจ้าของคำขอล่าสุด ไม่งั้นคำขอเก่าจะไปปิดไฟของคำขอใหม่
        if (seq === requestSeq.current) setLoadingArticles(false);
      }
    },
    [],
  );

  const loadStatus = useCallback(async (): Promise<{
    anyRunning: boolean;
    runs: RunRow[];
  }> => {
    const res = await fetch("/api/fetch/status");
    const data = await res.json();
    setRuns(data.runs ?? []);
    return data;
  }, []);

  useEffect(() => {
    loadTopics();
    loadStatus();
  }, [loadTopics, loadStatus]);

  useEffect(() => {
    // เปลี่ยนแค่แท็บ = ยอดไม่เปลี่ยน ไม่ต้องให้เซิร์ฟเวอร์นับใหม่
    const topicChanged = countedTopic.current !== selectedTopic;
    countedTopic.current = selectedTopic;
    loadArticles(selectedTopic, statusFilter, { withCounts: topicChanged });
  }, [selectedTopic, statusFilter, loadArticles]);

  /** โหลดใหม่หลังมีการแก้ข้อมูล — ต้องนับยอดใหม่เสมอเพราะจำนวนแต่ละสถานะเปลี่ยนไปแล้ว */
  const reloadArticles = useCallback(
    () => loadArticles(selectedTopic, statusFilter, { withCounts: true }),
    [loadArticles, selectedTopic, statusFilter],
  );

  // ประมวลผลข่าวค้างด้วย AI ทีละชุดเล็ก วนจนหมด (เว้นจังหวะให้อยู่ใน rate limit)
  const startProcessing = useCallback(async () => {
    setProcessing(true);
    const total = { drafted: 0, irrelevant: 0, failed: 0 };
    let lastError: string | null = null;
    type ProcessResponse = {
      drafted: number;
      irrelevant: number;
      failed: number;
      processed: number;
      remaining: number;
      lastError: string | null;
    };
    try {
      for (let i = 0; i < 100; i++) {
        // 10 ข่าว = 1 request ไปหา AI (ฝั่งเซิร์ฟเวอร์รวมเป็นชุดให้)
        const res = await postJson<ProcessResponse>("/api/process", {
          topicId: selectedTopic,
          limit: 10,
        });
        if (!res.ok) {
          lastError = res.error;
          break;
        }
        const data = res.data;
        total.drafted += data.drafted;
        total.irrelevant += data.irrelevant;
        total.failed += data.failed;
        lastError = data.lastError;
        await reloadArticles();
        if (data.remaining === 0 || data.processed === 0) break;
        // ทั้งชุดล้มเหลวหมด (เช่น ชน rate limit / key ผิด) — หยุดก่อน ไม่วนต่อ
        if (data.failed === data.processed) break;
        setMessage(
          `🤖 AI กำลังประมวลผล... เหลือ ${data.remaining} ข่าว (ร่างแล้ว ${total.drafted}, ไม่เกี่ยวข้อง ${total.irrelevant})`,
        );
      }
    } catch (err) {
      // เช่นเดียวกับ runLongForm — ห้ามปล่อยให้หน้าจอค้างที่ "กำลังประมวลผล..."
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      setProcessing(false);
    }
    const parts = [
      `ร่างโพสต์ ${total.drafted}`,
      `ไม่เกี่ยวข้อง ${total.irrelevant}`,
      ...(total.failed > 0
        ? [`ล้มเหลว ${total.failed} (${lastError ?? "?"})`]
        : []),
    ];
    setMessage(`🤖 ประมวลผลเสร็จ: ${parts.join(" • ")}`);
    await reloadArticles();
  }, [selectedTopic, reloadArticles]);

  /**
   * สั่งประมวลผลใหม่ทีละหลายข่าว — ตั้งสถานะกลับเป็น "รอประมวลผล" แล้วใช้ลูปเดิมทำงานต่อ
   * (ไม่มีทางประมวลผลคู่ขนาน จึงได้การรวมชุด/เว้นจังหวะ/บันทึกสถิติเหมือนกันทุกอย่าง)
   */
  const bulkReprocess = useCallback(async () => {
    const scope = statusFilter === "draft" || statusFilter === "irrelevant" ? statusFilter : null;
    const label = scope === "draft" ? "ร่างโพสต์" : scope === "irrelevant" ? "ไม่เกี่ยวข้อง" : "ร่างโพสต์และไม่เกี่ยวข้อง";
    if (
      !confirm(
        `ให้ AI ประมวลผลข่าว "${label}" ใหม่ (สูงสุด ${MAX_REPROCESS} ข่าวต่อครั้ง)?\n\n` +
          "แคปชันและสรุปเดิมจะถูกเขียนทับด้วยผลใหม่ ถ้าเคยแก้แคปชันเองไว้จะหายไป\n" +
          "ข่าวที่อนุมัติ/ตั้งเวลา/โพสแล้ว/ปฏิเสธ และร่างแบบยาว จะไม่ถูกแตะ",
      )
    ) {
      return;
    }
    setReprocessing(true);
    try {
      const res = await fetch("/api/articles/bulk-reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId: selectedTopic, ...(scope ? { status: scope } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`❌ ${data.error ?? "สั่งประมวลผลใหม่ไม่สำเร็จ"}`);
        return;
      }
      if (data.queued === 0) {
        setMessage("ไม่มีข่าวที่สั่งประมวลผลใหม่ได้ในขอบเขตนี้");
        return;
      }
      setMessage(
        `♻️ ตั้ง ${data.queued} ข่าวรอประมวลผลใหม่แล้ว` +
          (data.remaining > 0 ? ` (ยังเหลืออีก ${data.remaining} — กดซ้ำเพื่อทำต่อ)` : "") +
          " — กำลังเรียก AI...",
      );
      await reloadArticles();
    } finally {
      setReprocessing(false);
    }
    // ต่อด้วยลูปประมวลผลเดิมทันที ผู้ใช้จะได้ไม่ต้องกดสองปุ่ม
    await startProcessing();
  }, [selectedTopic, statusFilter, reloadArticles, startProcessing]);

  /**
   * เขียนแคปชันแบบยาวให้ข่าวเด่น — ระบบไปอ่านเนื้อข่าวจากเว็บจริงมาเป็นวัตถุดิบ
   *
   * ยิง **ทีละ 1 ข่าว วนหลายรอบ** ไม่ใช่ขอ 5 ข่าวในคำขอเดียว
   * เพราะ 5 ชิ้นในคำขอเดียวชนเพดาน 60 วินาทีของ Vercel เป็นประจำ:
   * วัดจริงจาก ai_call_logs ได้ AI ชิ้นเดียว p90 ~14 วิ — 5 ชิ้นก็ ~69 วิ เกินงบตั้งแต่
   * ยังไม่นับเวลาโหลดหน้าเว็บ พอโดนตัดกลางคันผู้ใช้เห็นแค่ error ทั้งที่บางชิ้นสำเร็จไปแล้ว
   *
   * ยิงทีละชิ้นแล้วแต่ละคำขอใช้เวลา ~14 วิในกรณีแย่ ๆ เหลือ margin 4 เท่า
   * และได้รายงานความคืบหน้าระหว่างทางฟรี ๆ (แพตเทิร์นเดียวกับปุ่มประมวลผล AI)
   */
  const runLongForm = useCallback(async () => {
    if (
      !confirm(
        `ให้ AI เลือกข่าวเด่นสูงสุด ${MAX_LONG_FORM} ข่าว แล้วเขียนแคปชันแบบยาว?\n\n` +
          "ระบบจะไปอ่านเนื้อข่าวจากเว็บสำนักข่าวจริง เพื่อให้เขียนได้ยาวโดยไม่แต่งข้อมูล\n" +
          "แคปชันเดิมของข่าวที่ถูกเลือกจะถูกเขียนทับ (ข่าวที่เว็บเปิดไม่ได้จะถูกข้าม)",
      )
    ) {
      return;
    }
    setLongForming(true);
    let generated = 0;
    let skipped = 0;
    let lastReason: string | null = null;
    let aborted: string | null = null;
    /**
     * id ที่ลองแล้วไม่สำเร็จ ต้องส่งไปบอกเซิร์ฟเวอร์ทุกรอบ
     * ไม่งั้นรอบถัดไปจะหยิบข่าวคะแนนสูงสุดตัวเดิมที่เพิ่งพังมาลองซ้ำจนครบทุกรอบ
     */
    const failed: number[] = [];
    /**
     * คำขอที่พังติดกัน — พังทีเดียวยังไปต่อ (อาจเป็นข่าวชิ้นนั้นชิ้นเดียวที่มีปัญหา)
     * แต่พังติดกันสองครั้งแปลว่าเซิร์ฟเวอร์มีปัญหาจริง วนต่อก็เสียเวลาผู้ใช้เปล่า
     */
    let consecutiveErrors = 0;

    type LongFormResponse = {
      generated: number;
      outcomes: { articleId: number; ok: boolean; reason?: string }[];
    };

    try {
      for (let round = 0; round < MAX_LONG_FORM; round++) {
        setMessage(
          `✨ กำลังอ่านเว็บและเขียนแคปชันยาว... (${generated}/${MAX_LONG_FORM} ข่าว)`,
        );
        const res = await postJson<LongFormResponse>("/api/articles/long-form", {
          topicId: selectedTopic,
          limit: 1,
          exclude: failed,
        });

        if (!res.ok) {
          lastReason = res.error;
          if (++consecutiveErrors >= 2) {
            aborted = res.error;
            break;
          }
          // งานฝั่งเซิร์ฟเวอร์บันทึกทีละชิ้นอยู่แล้ว รอบถัดไปจึงเริ่มจากของที่เหลือได้เลย
          await reloadArticles();
          continue;
        }
        consecutiveErrors = 0;

        const outcomes = res.data.outcomes ?? [];
        // ไม่มีผู้สมัครเหลือแล้ว — หยุด ไม่ต้องวนให้ครบรอบ
        if (outcomes.length === 0) break;

        generated += res.data.generated;
        for (const o of outcomes.filter((x) => !x.ok)) {
          skipped++;
          failed.push(o.articleId);
          lastReason = o.reason ?? lastReason;
        }
        // ได้ของแล้วรีเฟรชเลย ผู้ใช้จะได้เห็นทีละชิ้นแทนที่จะรอจนจบ
        if (res.data.generated > 0) await reloadArticles();
      }
    } catch (err) {
      // กันเหนียว: ต่อให้มีอะไรหลุดมาถึงตรงนี้ ผู้ใช้ต้องได้คำตอบเสมอ ห้ามค้างที่ "กำลังทำ..."
      aborted = err instanceof Error ? err.message : String(err);
    } finally {
      setLongForming(false);
    }

    const done = generated > 0 ? `เขียนแคปชันยาวสำเร็จ ${generated} ข่าว` : "ไม่ได้เขียนแคปชันยาวเลย";
    const skipNote = skipped > 0 ? ` • ข้าม ${skipped} ข่าว (${lastReason})` : "";
    setMessage(
      aborted
        ? `⚠️ หยุดกลางคัน — ${aborted} | ${done}${skipNote} — กดอีกครั้งเพื่อทำต่อ`
        : generated === 0
          ? `${done} — ${lastReason ?? "ไม่มีข่าวที่เข้าเกณฑ์"}`
          : `✨ ${done}${skipNote}`,
    );
    await reloadArticles();
  }, [selectedTopic, reloadArticles]);

  // ระหว่างดึง: poll สถานะทุก 2 วินาทีจนจบ สรุปผล แล้วส่งต่อให้ AI ประมวลผลอัตโนมัติ
  useEffect(() => {
    if (!fetching) return;
    const interval = setInterval(async () => {
      const data = await loadStatus();
      const batch = data.runs.filter((r) => batchRunIds.current.includes(r.id));
      const stillRunning = batch.some((r) => r.status === "running");
      if (!stillRunning) {
        setFetching(false);
        const summary = batch
          .map((r) =>
            r.status === "failed"
              ? `${r.topicName}: ดึงล้มเหลว (${r.errorMessage ?? "ไม่ทราบสาเหตุ"})`
              : `${r.topicName}: พบข่าวใหม่ ${r.newCount} รายการ (ข้าม ${r.duplicates} ที่ซ้ำ)`,
          )
          .join(" • ");
        setMessage(summary || "ดึงเสร็จแล้ว");
        await reloadArticles();
        const anyNew = batch.some((r) => r.newCount > 0);
        if (anyNew) startProcessing();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [fetching, loadStatus, reloadArticles, startProcessing]);

  /**
   * ดึงข่าวจริง — days = ย้อนหลังกี่วัน (ผู้ใช้เลือกจากกล่องถามก่อนหน้านี้)
   *
   * ต้องให้เลือกเพราะถ้าไม่ส่งตัวกรองเวลาไปเลย Google News คืนข่าวเก่ามากปนมาด้วย
   * (วัดจากของจริง: เก่าสุด 3,384 วัน) แล้วโควตา AI หมดไปกับการคัดกรองข่าวที่ตกยุคไปแล้ว
   */
  async function runFetch(days: number) {
    setFetchPromptOpen(false);
    setMessage(null);
    setFetching(true);
    const res = await postJson<{
      days: number;
      started: { runId: number }[];
      skipped: { topicName: string; reason: string }[];
    }>("/api/fetch", { topicId: selectedTopic, days });

    if (!res.ok) {
      setFetching(false);
      setMessage(`❌ ${res.error}`);
      return;
    }
    batchRunIds.current = (res.data.started ?? []).map((r) => r.runId);
    const skippedNote = (res.data.skipped ?? [])
      .map(
        (s) =>
          `${s.topicName}: ${s.reason === "locked" ? "กำลังดึงอยู่แล้ว" : "ปิดใช้งานอยู่"}`,
      )
      .join(" • ");
    if (batchRunIds.current.length === 0) {
      setFetching(false);
      setMessage(skippedNote || "ไม่มีหัวข้อให้ดึง");
    } else {
      setMessage(
        `🔄 กำลังดึงข่าว (${fetchWindowLabel(days)})...` +
          (skippedNote ? ` (${skippedNote})` : ""),
      );
    }
  }

  /**
   * ลบข่าวทั้งหมดที่กำลังแสดงอยู่ (เฉพาะสถานะที่ลบยกเข่งได้)
   * ผูกกับฟิลเตอร์ที่เห็นบนจอ เพื่อให้จำนวนที่บอกตรงกับที่จะลบจริงเสมอ
   */
  async function bulkDelete() {
    const label = statusLabel(statusFilter); // ป้ายเต็ม — ข้อความยืนยันต้องชัด ไม่ใช้ตัวย่อบนแท็บ
    const scope =
      selectedTopic === "all"
        ? "ทุกหัวข้อ"
        : (topics.find((t) => String(t.id) === selectedTopic)?.name ??
          "หัวข้อที่เลือก");
    const total = counts[statusFilter as keyof ArticleCounts] ?? 0;

    if (
      !window.confirm(
        `ลบข่าว "${label}" ทั้งหมด ${total} ชิ้น ใน${scope}?\n\n` +
          `ข่าวเหล่านี้จะถูกบล็อก ไม่ถูกดึงกลับมาอีก (และไม่ถูกส่งให้ AI ประเมินซ้ำ)\n` +
          `เปลี่ยนใจได้ที่หน้าจัดการหัวข้อ → "🚫 รายการที่บล็อกไว้"`,
      )
    ) {
      return;
    }

    setBulkDeleting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/articles/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusFilter, topicId: selectedTopic }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "ลบไม่สำเร็จ");
        return;
      }
      setMessage(
        `🗑️ ลบข่าว "${label}" ไปแล้ว ${data.deleted} ชิ้น (บล็อกไม่ให้กลับมาแล้ว)`,
      );
      await reloadArticles();
    } finally {
      setBulkDeleting(false);
    }
  }

  const lastRunByTopic = new Map<number, RunRow>();
  for (const run of runs) {
    if (!lastRunByTopic.has(run.topicId)) lastRunByTopic.set(run.topicId, run);
  }

  // ใช้ยอดจากเซิร์ฟเวอร์ ไม่ใช่ articleRows — รายการถูกจำกัด 200 แถวและถูกกรองตามแท็บอยู่
  const pendingCount = counts.fetched ?? 0;
  /**
   * กติกาเดียวของทุกปุ่มลงมือทำ: **โผล่เฉพาะแท็บที่มองเห็นของที่มันจะไปแตะ**
   *
   * เดิมปุ่มพวกนี้กองอยู่แถบบนสุด โผล่/หายตามยอดข่าวโดยไม่สนว่าเปิดแท็บไหนอยู่
   * ผลคือยืนอยู่แท็บ "โพสแล้ว" แต่เห็นปุ่ม "ประมวลผลใหม่ทั้งหมด (2)" — กดแล้วของที่เปลี่ยน
   * อยู่คนละแท็บ จอตรงหน้าไม่ขยับสักนิด แถมแถบบนยังเด้งสูงต่ำจนเลย์เอาต์ขยับตามไปด้วย
   *
   * ตอนนี้ย้ายลงมาอยู่กับหัวรายการของแต่ละแท็บ กดแล้วเห็นผลในจอเดียวกันทันที
   * แท็บ "ทั้งหมด" เห็นทุกปุ่มเพราะมองเห็นข่าวทุกสถานะอยู่จริง
   */
  const inScope = (s: string) => statusFilter === "all" || statusFilter === s;
  const canProcess = inScope("fetched") && pendingCount > 0;
  // ผู้สมัครของการเขียนยาวคือ status='draft' เท่านั้น (ดู selectLongFormCandidates)
  const canLongForm = inScope("draft") && (counts.draft ?? 0) > 0;
  // นับเฉพาะสถานะที่ทั้ง "ประมวลผลใหม่ได้" และ "มองเห็นอยู่ในแท็บนี้"
  const reprocessCount = REPROCESSABLE.filter(inScope).reduce(
    (n, s) => n + (counts[s] ?? 0),
    0,
  );
  /**
   * ลบยกเข่งไม่ตามกติกา inScope — จงใจไม่ให้โผล่ในแท็บ "ทั้งหมด"
   * ปุ่มลบถาวรที่กดได้จากหน้าที่เห็นข่าวทุกสถานะปนกัน อันตรายเกินกว่าจะแลกกับความสะดวก
   * (ดู BULK_DELETABLE ใน src/lib/bulk-delete.ts)
   */
  const bulkCount =
    statusFilter === "irrelevant" || statusFilter === "rejected"
      ? (counts[statusFilter] ?? 0)
      : 0;
  const shownTotal =
    counts[statusFilter as keyof ArticleCounts] ?? articleRows.length;
  // API คืนได้สูงสุด 200 แถว — ถ้ายอดจริงมากกว่าที่ได้มา แปลว่ารายการถูกตัด
  const truncated = shownTotal > articleRows.length;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      {/*
        ถามช่วงเวลาก่อนดึงทุกครั้ง — ใช้กล่องของเราเองแทน confirm() เพราะมี 3 ตัวเลือก
        (confirm ให้ได้แค่ตกลง/ยกเลิก) และต้องอธิบายแต่ละตัวเลือกให้เข้าใจก่อนกด
      */}
      {fetchPromptOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="fetch-window-title"
          onClick={() => setFetchPromptOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-gray-900"
            // กันคลิกในกล่องทะลุไปโดนพื้นหลังจนกล่องปิดเอง
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="fetch-window-title" className="text-lg font-semibold">
              ดึงข่าวย้อนหลังกี่วัน?
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              ยิ่งย้อนไกล ยิ่งได้ข่าวเยอะแต่เก่าลง และกินโควตา AI มากขึ้นตาม
            </p>

            <div className="mt-4 space-y-2">
              {FETCH_WINDOW_PRESETS.map((p) => (
                <button
                  key={p.days}
                  onClick={() => runFetch(p.days)}
                  className="flex w-full items-baseline justify-between rounded-lg border border-gray-300 px-4 py-3 text-left transition-colors hover:border-blue-500 hover:bg-blue-50 dark:border-gray-600 dark:hover:border-blue-500 dark:hover:bg-blue-950"
                >
                  <span className="font-medium">{p.label}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {p.hint}
                  </span>
                </button>
              ))}
            </div>

            <button
              onClick={() => setFetchPromptOpen(false)}
              className="mt-4 w-full rounded-lg px-4 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              ยกเลิก
            </button>
          </div>
        </div>
      )}

      <header className="mb-6">
        <h1 className="text-2xl font-bold">PostMaid</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          รวบรวมข่าวตามหัวข้อที่สนใจ พร้อมเตรียมโพสลง Facebook
        </p>
      </header>

      <section className="mb-6 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium" htmlFor="topic-select">
            หัวข้อ:
          </label>
          <select
            id="topic-select"
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
            value={selectedTopic}
            onChange={(e) => setSelectedTopic(e.target.value)}
          >
            <option value="all">ทุกหัวข้อ</option>
            {topics.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.name}
                {t.enabled ? "" : " (ปิดอยู่)"}
              </option>
            ))}
          </select>

          <button
            onClick={() => setFetchPromptOpen(true)}
            disabled={fetching || processing}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {fetching ? "⏳ กำลังดึงข่าว..." : "🔄 ดึงข่าวทันที"}
          </button>
        </div>

        {message && (
          <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200">
            {message}
          </p>
        )}

        {topics.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            {topics.map((t) => {
              const last = lastRunByTopic.get(t.id);
              return (
                <span key={t.id}>
                  {t.name}: ดึงล่าสุด{" "}
                  {last
                    ? formatDate(last.finishedAt ?? last.startedAt)
                    : "ยังไม่เคยดึง"}
                </span>
              );
            })}
          </div>
        )}
      </section>

      {/* แท็บสถานะ — sticky ไว้เพราะรายการข่าวยาว ผู้ใช้ต้องสลับแท็บได้โดยไม่ต้องเลื่อนขึ้น */}
      <div
        role="tablist"
        aria-label="กรองตามสถานะ"
        className="sticky top-0 z-10 -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-gray-200 bg-white/80 px-4 py-2 backdrop-blur dark:border-gray-800 dark:bg-gray-950/80"
      >
        {STATUS_TABS.map((tab) => {
          const n = counts[tab.value as keyof ArticleCounts] ?? 0;
          const active = statusFilter === tab.value;
          return (
            <button
              key={tab.value}
              role="tab"
              aria-selected={active}
              onClick={() => setStatusFilter(tab.value)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-gray-900 font-semibold text-white dark:bg-white dark:text-gray-900"
                  : n === 0
                    ? "text-gray-400 hover:bg-gray-100 dark:text-gray-600 dark:hover:bg-gray-800"
                    : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              }`}
            >
              {tab.dot && (
                <span
                  className={`h-1.5 w-1.5 rounded-full ${tab.dot} ${active ? "" : n === 0 ? "opacity-40" : ""}`}
                />
              )}
              {tab.label}
              <span
                className={`tabular-nums ${active ? "opacity-80" : "text-gray-400 dark:text-gray-500"}`}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>

      <section>
        {/* หัวรายการ + ปุ่มลงมือทำของแท็บนี้ อยู่บรรทัดเดียวกัน เพื่อผูกปุ่มเข้ากับของที่มันแตะ */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="flex flex-wrap items-baseline gap-x-2 text-lg font-semibold">
            {statusFilter === "all" ? "ข่าวทั้งหมด" : statusLabel(statusFilter)}
            <span className="text-sm font-normal text-gray-500">
              {/* บอกตามจริงเมื่อรายการถูกตัด — เดิมโชว์ "200 รายการ" ทั้งที่มีมากกว่านั้น */}
              {loadingArticles
                ? "กำลังโหลด..."
                : truncated
                  ? `แสดง ${articleRows.length} จาก ${shownTotal} รายการ`
                  : `${shownTotal} รายการ`}
            </span>
          </h2>

          <div className="flex flex-wrap items-center gap-2">
            {canProcess && (
              <button
                onClick={startProcessing}
                disabled={fetching || processing}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {processing
                  ? "⏳ AI กำลังประมวลผล..."
                  : `🤖 ประมวลผล AI (ค้าง ${pendingCount})`}
              </button>
            )}

            {canLongForm && (
              <button
                onClick={runLongForm}
                disabled={fetching || processing || reprocessing || longForming}
                className="rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                title={`ให้ AI เลือกข่าวเด่นสูงสุด ${MAX_LONG_FORM} ข่าว ไปอ่านเนื้อจากเว็บจริง แล้วเขียนแคปชันแบบยาว`}
              >
                {longForming ? "⏳ กำลังอ่านเว็บ..." : `✨ เขียนยาว ${MAX_LONG_FORM} ข่าวเด่น`}
              </button>
            )}

            {reprocessCount > 0 && (
              <button
                onClick={bulkReprocess}
                disabled={fetching || processing || reprocessing || bulkDeleting}
                className="rounded-lg border border-indigo-200 px-3 py-2 text-sm font-medium text-indigo-600 transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-900 dark:text-indigo-400 dark:hover:bg-indigo-950"
                title={`ให้ AI เขียนแคปชันใหม่ทั้งหมด (สูงสุด ${MAX_REPROCESS} ข่าวต่อครั้ง) — ไม่แตะข่าวที่อนุมัติ/โพสแล้ว`}
              >
                {reprocessing
                  ? "⏳ กำลังตั้งคิว..."
                  : `♻️ ประมวลผลใหม่ทั้งหมด (${Math.min(reprocessCount, MAX_REPROCESS)})`}
              </button>
            )}

            {bulkCount > 0 && (
              <button
                onClick={bulkDelete}
                disabled={fetching || processing || bulkDeleting}
                className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
                title="ลบข่าวทั้งหมดในแท็บนี้ พร้อมบล็อกไม่ให้ถูกดึงกลับมาอีก"
              >
                {bulkDeleting ? "⏳ กำลังลบ..." : `🗑️ ลบทั้งหมด (${bulkCount})`}
              </button>
            )}
          </div>
        </div>
        {loadingArticles && articleRows.length === 0 ? (
          /* ยังไม่มีอะไรให้โชว์ — ขึ้นโครงหลอกไว้ก่อน ดีกว่าจอว่างที่ดูเหมือนไม่มีข่าว */
          <ul className="space-y-3" aria-busy="true" aria-label="กำลังโหลดรายการข่าว">
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="animate-pulse rounded-xl border border-gray-200 p-4 dark:border-gray-700"
              >
                <div className="mb-3 h-4 w-3/4 rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mb-2 h-3 w-1/3 rounded bg-gray-100 dark:bg-gray-800" />
                <div className="h-3 w-full rounded bg-gray-100 dark:bg-gray-800" />
              </li>
            ))}
          </ul>
        ) : articleRows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700">
            {counts.all === 0
              ? 'ยังไม่มีข่าวในระบบ — กด "ดึงข่าวทันที" เพื่อเริ่ม'
              : `ไม่มีข่าวสถานะ "${statusLabel(statusFilter)}" — ลองเลือกแท็บอื่น`}
          </p>
        ) : (
          /*
           * ระหว่างโหลดแท็บใหม่ ยังโชว์รายการเดิมอยู่แต่หรี่ลงและกดไม่ได้
           * เพื่อไม่ให้เข้าใจผิดว่าข้อมูลที่เห็นคือของแท็บใหม่แล้ว (ปัญหาเดิมคือดูเหมือนค้าง)
           */
          <ul
            className={`space-y-3 transition-opacity duration-150 ${
              loadingArticles ? "pointer-events-none opacity-40" : ""
            }`}
            aria-busy={loadingArticles}
          >
            {articleRows.map((a) => (
              <ArticleCard key={a.id} article={a} onChanged={reloadArticles} />
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8 text-center text-xs text-gray-400">
        จัดการหัวข้อได้ที่หน้า{" "}
        <Link href="/topics" className="underline">
          จัดการหัวข้อ
        </Link>
      </p>
    </div>
  );
}
