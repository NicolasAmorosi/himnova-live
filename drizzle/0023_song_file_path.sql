--> A library song imported from a song file stays tied to it: saving it writes that file (owner, 2026-11-05).
--> Its song of the file and mtime reuse `source_index`/`source_mtime`; `source_folder` stays NULL (= the library).
ALTER TABLE `songs` ADD `file_path` text;
