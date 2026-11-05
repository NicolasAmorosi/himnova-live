CREATE TABLE `song_themes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`style_json` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ix_song_themes_order` ON `song_themes` (`sort_order`);--> statement-breakpoint
CREATE TABLE `songs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`number` text,
	`authors` text,
	`copyright` text,
	`ccli_number` text,
	`notes` text,
	`sections_json` text NOT NULL,
	`order_json` text NOT NULL,
	`theme_id` integer,
	`lyrics_text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`theme_id`) REFERENCES `song_themes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ix_songs_title` ON `songs` (`title`);--> statement-breakpoint
-- FTS5 over a song's title, number, authors and every line of its lyrics, external-content like
-- `bible_verses_fts`: `unicode61 remove_diacritics 2` makes "senor" find "Señor".
CREATE VIRTUAL TABLE `songs_fts` USING fts5(
	title,
	number,
	authors,
	lyrics_text,
	content='songs',
	content_rowid='id',
	tokenize="unicode61 remove_diacritics 2"
);
--> statement-breakpoint
CREATE TRIGGER `songs_ai` AFTER INSERT ON `songs` BEGIN
	INSERT INTO `songs_fts`(rowid, title, number, authors, lyrics_text)
	VALUES (new.id, new.title, new.number, new.authors, new.lyrics_text);
END;
--> statement-breakpoint
CREATE TRIGGER `songs_ad` AFTER DELETE ON `songs` BEGIN
	INSERT INTO `songs_fts`(`songs_fts`, rowid, title, number, authors, lyrics_text)
	VALUES ('delete', old.id, old.title, old.number, old.authors, old.lyrics_text);
END;
--> statement-breakpoint
CREATE TRIGGER `songs_au` AFTER UPDATE ON `songs` BEGIN
	INSERT INTO `songs_fts`(`songs_fts`, rowid, title, number, authors, lyrics_text)
	VALUES ('delete', old.id, old.title, old.number, old.authors, old.lyrics_text);
	INSERT INTO `songs_fts`(rowid, title, number, authors, lyrics_text)
	VALUES (new.id, new.title, new.number, new.authors, new.lyrics_text);
END;
--> statement-breakpoint
--> `program_items` rebuilt by hand, not the `ALTER TABLE … ADD song_id` drizzle-kit emits, for
--> 0011's and 0015's two reasons: that loses the `ON DELETE restrict` (deleting a song a saved
--> program uses is the operator's decision, `song:usages`) and leaves the table's CHECK —
--> invisible to Drizzle — rejecting every `kind = 'song'` row. Same rebuild as 0015, a fifth branch.
CREATE TABLE `__new_program_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`program_id` integer NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`media_asset_id` integer,
	`utility_scene_id` integer,
	`overlay_plate_id` integer,
	`song_id` integer,
	`bible_version_id` integer,
	`bible_book_id` integer,
	`bible_chapter` integer,
	`bible_verse_from` integer,
	`bible_verse_to` integer,
	`bible_reference` text,
	`bible_text` text,
	`title` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`utility_scene_id`) REFERENCES `utility_scenes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`overlay_plate_id`) REFERENCES `overlay_plates`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bible_version_id`) REFERENCES `bible_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bible_book_id`) REFERENCES `bible_books`(`id`) ON UPDATE no action ON DELETE set null,
	CHECK (
		(`kind` IN ('media','ppt') AND `media_asset_id` IS NOT NULL AND `bible_text` IS NULL AND `utility_scene_id` IS NULL AND `overlay_plate_id` IS NULL AND `song_id` IS NULL) OR
		(`kind` = 'bible' AND `bible_text` IS NOT NULL AND `media_asset_id` IS NULL AND `utility_scene_id` IS NULL AND `overlay_plate_id` IS NULL AND `song_id` IS NULL) OR
		(`kind` = 'utility' AND `utility_scene_id` IS NOT NULL AND `media_asset_id` IS NULL AND `bible_text` IS NULL AND `overlay_plate_id` IS NULL AND `song_id` IS NULL) OR
		(`kind` = 'plate' AND `overlay_plate_id` IS NOT NULL AND `media_asset_id` IS NULL AND `bible_text` IS NULL AND `utility_scene_id` IS NULL AND `song_id` IS NULL) OR
		(`kind` = 'song' AND `song_id` IS NOT NULL AND `media_asset_id` IS NULL AND `bible_text` IS NULL AND `utility_scene_id` IS NULL AND `overlay_plate_id` IS NULL)
	)
);--> statement-breakpoint
INSERT INTO `__new_program_items` (
	`id`, `program_id`, `position`, `kind`, `media_asset_id`, `utility_scene_id`, `overlay_plate_id`,
	`bible_version_id`, `bible_book_id`, `bible_chapter`, `bible_verse_from`, `bible_verse_to`,
	`bible_reference`, `bible_text`, `title`, `created_at`
) SELECT
	`id`, `program_id`, `position`, `kind`, `media_asset_id`, `utility_scene_id`, `overlay_plate_id`,
	`bible_version_id`, `bible_book_id`, `bible_chapter`, `bible_verse_from`, `bible_verse_to`,
	`bible_reference`, `bible_text`, `title`, `created_at`
FROM `program_items`;--> statement-breakpoint
DROP TABLE `program_items`;--> statement-breakpoint
ALTER TABLE `__new_program_items` RENAME TO `program_items`;--> statement-breakpoint
CREATE INDEX `ix_items_program` ON `program_items` (`program_id`,`position`);