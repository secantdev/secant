CREATE TABLE `run_owner` (
	`singleton` integer PRIMARY KEY,
	`owner_epoch` integer NOT NULL,
	`owner_pid` integer
);
