## An FTS5 'rebuild' after a bulk insert does not replace the sync triggers — they had already run, row by row
**Area:** data
**Trigger:** a bulk insert into a table kept in step with an external-content FTS5 index by `AFTER INSERT` triggers (`bible_verses` → `bible_verses_fts`, `songs` → `songs_fts`); a Bible install or import that feels slow, or slower than the one before

- Believed (the seed's comment and `05-data-and-persistence.md` until 2026-11-09): `seedBibleFromFile` loads the
  31 102 verses and then runs `INSERT INTO bible_verses_fts(bible_verses_fts) VALUES('rebuild')` "instead of
  letting the triggers run 31 102 times". False: a trigger cannot be skipped by running something after it.
  `bible_verses_ai` (`drizzle/0000_init.sql`) fired on every INSERT, and the 'rebuild' then threw that index away
  and re-indexed **every installed version**, not the new one.
- Measured on the M-series Mac (2026-11-09, `better-sqlite3`, one transaction): 31 102 verses with the trigger,
  ~510 ms of INSERTs; with the trigger dropped, 50 ms of INSERTs + 55 ms for one
  `INSERT INTO bible_verses_fts(rowid, text) SELECT id, text FROM bible_verses WHERE version_id = ?`. The
  'rebuild' alone cost ~75 ms per installed version (374 ms with five), so every new bible installed slower than
  the one before: the 2nd–5th took 1.6–2.2 s each, the whole Portuguese pair 9.9 s in the test suite. With the
  trigger set aside: ~0.4 s per version (parse included), a new English profile's three versions ~1.2 s.
- What to do: inside the bulk load's transaction, read the trigger's own SQL from `sqlite_master`, `DROP TRIGGER`,
  insert the rows, index only those rows with one `INSERT … SELECT`, and `exec` the saved SQL to put it back. DDL is
  transactional in SQLite, so a failure mid-load restores the trigger with the rollback. FTS5's own
  `integrity-check` command (`INSERT INTO bible_verses_fts(bible_verses_fts, rank) VALUES('integrity-check', 1)`)
  agrees with the table afterwards — asserted in `tests/main/bundled-bibles.test.ts`.
- Not done (yet): the cascade DELETE of a re-seed still fires `bible_verses_ad` 31 102 times (~0.5 s); it only runs
  when a bundled file changed or a version is deleted.

**Last updated:** 2026-11-09
