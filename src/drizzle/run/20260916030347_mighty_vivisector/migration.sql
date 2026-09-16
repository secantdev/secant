CREATE TABLE `pending_gate` (
	`attempt_id` text PRIMARY KEY,
	`step_id` text NOT NULL,
	`shape` text NOT NULL,
	`message` text NOT NULL,
	`output_artifact_name` text,
	`raised_at` text NOT NULL
);
