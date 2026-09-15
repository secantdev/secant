CREATE TABLE IF NOT EXISTS `catalog_entries` (
	`id` text NOT NULL,
	`version` text NOT NULL,
	`digest` text NOT NULL,
	`origin_kind` text NOT NULL,
	`origin_location` text NOT NULL,
	`installed_at` text NOT NULL,
	`installation_generation` integer NOT NULL,
	CONSTRAINT `catalog_entries_pk` PRIMARY KEY(`id`, `version`)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `trust_grants` (
	`digest` text NOT NULL,
	`installation_generation` integer NOT NULL,
	`operation_id` text NOT NULL,
	`granted_at` text NOT NULL,
	CONSTRAINT `trust_grants_pk` PRIMARY KEY(`digest`, `installation_generation`)
) STRICT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_approvals` (
	`path` text PRIMARY KEY,
	`approved_at` text NOT NULL
) STRICT;
