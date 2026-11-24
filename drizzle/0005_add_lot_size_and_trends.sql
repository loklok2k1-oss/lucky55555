ALTER TABLE `stocks` ADD COLUMN `lot_size` integer;
--> statement-breakpoint
CREATE TABLE `trends` (
	`code` text PRIMARY KEY NOT NULL,
	`trend` text DEFAULT '' NOT NULL,
	`ma20` real,
	`ma50` real,
	`day` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT 0 NOT NULL
);
