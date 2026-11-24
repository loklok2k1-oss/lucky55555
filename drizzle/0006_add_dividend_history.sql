CREATE TABLE `dividend_history` (
	`code` text PRIMARY KEY NOT NULL,
	`ttm_dps` real,
	`yearly` text DEFAULT '[]' NOT NULL,
	`trend` text DEFAULT '' NOT NULL,
	`eps` real,
	`day` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT 0 NOT NULL
);
