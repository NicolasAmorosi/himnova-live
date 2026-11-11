## A second SQLite connection turns a deferred read-then-write into SQLITE_BUSY_SNAPSHOT, which `busy_timeout` never waits out
**Area:** data
**Trigger:** writing to `worship.db` from a worker thread or any connection other than main's (`seed-bible-worker.ts`), or a transaction that reads before it writes while another connection may commit

- Until 2026-11-10 one connection did everything, so better-sqlite3's default `transaction()` (`BEGIN DEFERRED`) was never contended. Installing a Bible moved to a worker with a connection of its own (it held main ~260 ms and froze engine video on air).
- In WAL a deferred transaction takes its read snapshot at its first read and asks for the write lock only at its first write. If another connection commits in between, the upgrade fails at once with `SQLITE_BUSY_SNAPSHOT`: `busy_timeout` (5 s here) only waits for a lock to be released, and a stale snapshot never becomes fresh. `seedBibleFromFile` reads `max(sort_order)` before inserting, so two installs at once — two workers — would fail one.
- Hence `run.immediate()` in `seedBibleFromFile`: the write lock is taken at `BEGIN`, where `busy_timeout` does wait. Single statements (autocommit) are immune, and that is all main writes during an install, except a transaction of main's that read before the worker committed — the ceiling: a ~150 ms window, a rejected IPC call (toast), never lost data. Make that transaction `.immediate()` too if it ever shows up.
- Schema changes inside the worker's transaction (it drops and recreates `bible_verses_ai`) are fine for main: its prepared statements re-prepare on `SQLITE_SCHEMA` by themselves.

**Last updated:** 2026-11-10
