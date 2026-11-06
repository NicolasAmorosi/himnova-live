--> A song read from a file in a linked folder: which folder, file and song of that file, and the file's mtime.
--> Replaces an unreleased `0022_song_folders` (folders of the app's own, 2026-11-05) that the owner's own profile
--> ran: its `song_folders` table and `songs.folder_id` stay there, empty and unused — dropping a column that a
--> foreign key names takes a rebuild of `songs`, its FTS triggers and every table pointing at it.
ALTER TABLE `songs` ADD `source_folder` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `source_file` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `source_index` integer;--> statement-breakpoint
ALTER TABLE `songs` ADD `source_mtime` integer;--> statement-breakpoint
CREATE INDEX `ix_songs_source` ON `songs` (`source_folder`,`source_file`,`source_index`);
