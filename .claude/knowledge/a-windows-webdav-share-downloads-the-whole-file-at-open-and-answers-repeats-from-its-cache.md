## A Windows WebDAV share downloads the whole file at open and answers repeats from its cache
**Area:** slides
**Trigger:** simulating a hung or slow network share on Windows to test a deck read (the hymnal's clock, a read-ahead
cut, the app's close with a read stuck), a share test whose numbers look too good, or a read that should beat and never
does

- Believed (2026-11-23): a WebDAV folder served over loopback (`\\localhost@<port>\DavWWWRoot\...`, a small Node
  server that can stall or throttle) stands in for a church's NAS, and reads go to the server part by part as the
  app asks for them, like SMB.
- True, measured on Windows: the WebDAV redirector (the `WebClient` service) downloads the ENTIRE file when the app
  opens it, before the first read returns, and keeps a copy. So:
  - the first batch of runs never reached the server after the first one: every open was answered from the
    redirector's copy, and the «hung» share looked instant. Those runs had to be thrown away; each run needs a new
    folder (or file name) on the server;
  - a request for another file seems to wait behind a hung open inside the redirector itself (deduced from the
    server's log, where no request for it ever arrived, not measured), which looks like the app's queue and is not;
  - a read that beats per sector (the hymnal, RN3-2) sends no beat over WebDAV, because the whole wait happens inside
    the open; a slow but healthy file is cut by any clock shorter than its download. SMB reads by parts and should
    beat (not measured yet).
- Use WebDAV only for «the share stopped answering at open»; for «slow but reading» or anything about beats, use a
  share that reads by parts (SMB, or a server that answers `Range` slowly). Check the server's log for each request
  before trusting a time.
- Drivers and raw data: the maintainer's `docs/auditorias/2026-11-22-noche/herramientas/material-real/manana-1123/`
  (`rn32-rm5/`, `RN3-2-RM5.md`).

**Last updated:** 2026-11-23
