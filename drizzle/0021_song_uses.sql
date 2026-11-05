CREATE TABLE `song_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`song_id` integer,
	`used_at` integer NOT NULL,
	`title` text NOT NULL,
	`authors` text,
	`ccli_number` text,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_song_uses_time` ON `song_uses` (`used_at`);--> statement-breakpoint
CREATE INDEX `ix_song_uses_song` ON `song_uses` (`song_id`);