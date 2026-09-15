CREATE TABLE IF NOT EXISTS `artifact_binding` (
	`artifact_name` text PRIMARY KEY,
	`version_id` text NOT NULL,
	`updated_at` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `artifact_version` (
	`version_id` text NOT NULL,
	`artifact_name` text NOT NULL,
	`artifact_type` text NOT NULL,
	`attempt_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `artifact_version_pk` PRIMARY KEY(`version_id`, `artifact_name`)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `attempt_log` (
	`seq` integer PRIMARY KEY,
	`attempt_id` text NOT NULL,
	`outcome` text NOT NULL,
	`at` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `attempt` (
	`attempt_id` text PRIMARY KEY,
	`outcome` text NOT NULL,
	`version_id` text,
	`settled_at` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `gate_answer` (
	`seq` integer PRIMARY KEY,
	`answer_id` text NOT NULL,
	`operation_id` text NOT NULL UNIQUE,
	`gate_attempt_id` text NOT NULL,
	`answer` text NOT NULL,
	`iterations_at_grant` integer NOT NULL,
	`version_id` text NOT NULL,
	`at` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `materialization_conflict` (
	`seq` integer PRIMARY KEY,
	`diagnostic_id` text NOT NULL,
	`artifact_name` text NOT NULL,
	`artifact_path` text NOT NULL,
	`version_id` text NOT NULL,
	`at` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `run_record` (
	`run_id` text PRIMARY KEY,
	`workspace_path` text NOT NULL,
	`bundle_snapshot_digest` text NOT NULL,
	`launch` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text NOT NULL
) STRICT;
