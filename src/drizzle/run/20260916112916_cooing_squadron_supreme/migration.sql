CREATE TABLE `harness_session` (
	`session_key` text PRIMARY KEY,
	`native_session_id` text,
	`availability` text NOT NULL,
	`availability_detail` text,
	`harness` text NOT NULL,
	`profile_digest` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcript_entry` (
	`seq` integer PRIMARY KEY,
	`session_key` text NOT NULL,
	`turn_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn_event` (
	`seq` integer PRIMARY KEY,
	`turn_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turn` (
	`turn_id` text PRIMARY KEY,
	`attempt_id` text NOT NULL,
	`session_key` text NOT NULL,
	`origin` text NOT NULL,
	`sequence` integer NOT NULL,
	`input` text NOT NULL,
	`admitted_at` text NOT NULL,
	`result_kind` text,
	`result_detail` text,
	`settled_at` text
);
--> statement-breakpoint
ALTER TABLE `attempt` ADD `effective_model` text;