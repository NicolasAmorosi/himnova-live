## A file's `mtimeMs` keeps a fraction of a millisecond and `Date.now()` drops it

**Area:** db (`src/main/db/migrate.ts`, `dailyBackupDue`), and anything that compares a file's time with the clock
**Trigger:** comparing `fs.statSync(f).mtimeMs` with `Date.now()`, a «from the future» check, or a Vitest failure that
shows up once in a dozen runs on a loaded Mac.

- Believed: a file written just now has `mtimeMs <= Date.now()`.
- True (found 2026-11-20, the unexplained Vitest failure of 2026-11-19): `mtimeMs` is a float with sub-millisecond
  precision, `Date.now()` is a whole millisecond. A file written in the same millisecond as `now` reads up to ~1 ms
  ahead of it. `dailyBackupDue` took that as a clock set back and took a second copy; its test failed about 1 run in 13.
- Fix: a copy up to `CLOCK_SLACK_MS` (60 s) ahead counts as taken now. The test that fails without it sets the copy's
  mtime to `now + 0.6 ms` (`tests/main/migrations-with-data.test.ts`).
- Rule: never compare a file time with the clock at exact precision; allow a slack, or `Math.trunc` both sides (as
  `media.repo.ts` does for its stored `mtimeMs`).

**Last updated:** 2026-11-20
