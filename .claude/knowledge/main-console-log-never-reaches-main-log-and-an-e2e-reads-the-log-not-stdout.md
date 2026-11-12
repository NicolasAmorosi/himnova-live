## Main's `console.log` never reaches `main.log`, and an E2E reads the log, not the app's stdout
**Area:** build
**Trigger:** a line main prints that is missing from a church's `main.log`; an E2E that waits for something the app or the engine prints and times out on one OS only

- `installMainLog()` (`src/main/logging.ts`) copies only `console.info`/`warn`/`error` into `main.log`. A `console.log` is lost on a packaged Windows app (no console), so a diagnostic meant for a support case has to be `info` or above. The engine's GPU line was `console.log` until 2026-11-12 and never reached the log on the Linux run that needed it.
- Playwright's `_electron.launch` attaches to the app's stdout late: what main or a child (the spare media engine starts at launch) writes in the first moments can be gone before the test listens. The WARP E2E read stdout and missed the engine's line on Windows; it reads `main.log` from the profile instead (`media-engine.spec`), and passed again there.

**Last updated:** 2026-11-12
