-- News Curator — schema DDL สำหรับ Turso
-- ใช้เมื่ออยากตั้งตารางผ่าน "SQL console บนหน้าเว็บ Turso" แทนการรัน `npm run db:push` จาก CLI
--
-- วิธีใช้: เปิด https://app.turso.tech → เลือกฐานข้อมูล → เมนู SQL/Shell → วางทั้งไฟล์นี้แล้ว Run
-- (ไฟล์นี้ generate จาก schema จริงด้วย `npx drizzle-kit export` แล้วจัดลำดับให้ตารางแม่มาก่อน
--  + ใส่ IF NOT EXISTS ให้รันซ้ำได้ปลอดภัย)
--
-- ⚠️ ถ้า schema ใน src/db/schema.ts เปลี่ยน ต้อง generate ไฟล์นี้ใหม่ (ดู DEPLOY.md)

-- ── ตารางแม่ (ไม่มี FK ไปตารางอื่น) ────────────────────────────────
CREATE TABLE IF NOT EXISTS `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`access_expires_at` integer,
	`email` text,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);
CREATE UNIQUE INDEX IF NOT EXISTS `users_email_unique` ON `users` (`email`);

CREATE TABLE IF NOT EXISTS `auth_attempts` (
	`identifier` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL
);

-- ── topics (อ้าง users) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `topics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer,
	`name` text NOT NULL,
	`keywords` text NOT NULL,
	`ai_context` text,
	`caption_style` text,
	`caption_include_summary` integer DEFAULT false NOT NULL,
	`news_source` text DEFAULT 'auto' NOT NULL,
	`fb_page_id` text,
	`fb_page_token` text,
	`cron_schedule` text DEFAULT '0 7 * * *' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ── sessions (อ้าง users) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ── admin_audit_log (อ้าง users) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS `admin_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer,
	`actor_username` text NOT NULL,
	`target_id` integer,
	`target_username` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text DEFAULT 'success' NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);

-- ── articles (อ้าง topics) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`resolved_url` text,
	`source` text,
	`published_at` integer,
	`description` text,
	`image_url` text,
	`status` text DEFAULT 'fetched' NOT NULL,
	`relevance_score` real,
	`interest_score` real,
	`content` text,
	`long_form_failed_at` integer,
	`summary` text,
	`caption` text,
	`hashtags` text,
	`fb_post_id` text,
	`fb_post_url` text,
	`posted_at` integer,
	`scheduled_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS `articles_topic_url_unique` ON `articles` (`topic_id`,`url`);

-- ── blocked_articles (อ้าง topics) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS `blocked_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`url` text NOT NULL,
	`title_key` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS `blocked_articles_topic_url_unique` ON `blocked_articles` (`topic_id`,`url`);

-- ── fetch_runs (อ้าง topics) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS `fetch_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`found` integer DEFAULT 0 NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`duplicates` integer DEFAULT 0 NOT NULL,
	`blocked` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);

-- ── ai_call_logs (อ้าง topics) — สถิติการเรียก AI ไว้ดูว่ากำลังเสื่อมหรือยัง ──
CREATE TABLE IF NOT EXISTS `ai_call_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer,
	`topic_name` text NOT NULL,
	`model` text NOT NULL,
	`mode` text NOT NULL,
	`requested` integer NOT NULL,
	`returned` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`ok` integer NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE set null
);
