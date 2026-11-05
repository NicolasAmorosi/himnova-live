CREATE TABLE `bible_recents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version_code` text NOT NULL,
	`book_abbrev` text NOT NULL,
	`chapter` integer NOT NULL,
	`verse_from` integer NOT NULL,
	`verse_to` integer NOT NULL,
	`reference` text NOT NULL,
	`projected_at` integer NOT NULL
);
