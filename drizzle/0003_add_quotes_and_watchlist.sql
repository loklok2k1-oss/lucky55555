CREATE TABLE IF NOT EXISTS `quotes` (
  `code` text PRIMARY KEY NOT NULL,
  `price` real NOT NULL DEFAULT 0,
  `change` real,
  `change_pct` real,
  `day_high` real,
  `day_low` real,
  `week52_high` real,
  `week52_low` real,
  `name` text NOT NULL DEFAULT '',
  `market_status` text NOT NULL DEFAULT '',
  `as_of` text NOT NULL DEFAULT '',
  `updated_at` integer NOT NULL DEFAULT 0,
  `ok` integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `watchlist` (
  `code` text PRIMARY KEY NOT NULL,
  `created_at` integer NOT NULL DEFAULT 0
);
