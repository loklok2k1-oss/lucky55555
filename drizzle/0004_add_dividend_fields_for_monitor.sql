ALTER TABLE `quotes` ADD COLUMN `dividend_yield` real;
--> statement-breakpoint
ALTER TABLE `quotes` ADD COLUMN `dividend_rate` real;
--> statement-breakpoint
ALTER TABLE `stocks` ADD COLUMN `dps` real;
