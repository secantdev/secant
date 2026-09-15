CREATE TABLE IF NOT EXISTS `operations` (
	`operation_id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`run_id` text NOT NULL,
	`recorded_at` text NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `runs` (
	`run_id` text PRIMARY KEY,
	`owner_epoch` integer NOT NULL,
	`owner_pid` integer,
	`created_at` text NOT NULL
) STRICT;
