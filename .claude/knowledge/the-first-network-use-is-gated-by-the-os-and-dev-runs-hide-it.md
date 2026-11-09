## The NDI output's first network use is gated by the OS — silently until answered — and a dev run hides it
**Area:** build
**Trigger:** the NDI output listed by receivers but no picture arriving, testing NDI from `npm run dev`/Playwright, or touching `mac.extendInfo` in `package.json`

- **macOS Local Network:** the engine is a child, but the prompt comes in the **app's** name («Lumina Live», with `NSLocalNetworkUsageDescription`). Until it is answered, traffic to the LAN is dropped in silence: other machines list «MAC (Lumina Live)» and get no frame. A receiver on the same Mac (127.0.0.1) is never affected.
- A dev build launched by Playwright from a terminal inherits **the terminal's** permission, so Mac → another machine worked in dev and proved nothing about the package. Test the packaged `.app` opened through LaunchServices (`open -n -a … --env LUMINA_NDI_LIB=… --args --user-data-dir=…`) — measured 2026-11-09: no picture until the prompt was allowed, then Windows received it.
- **Windows Firewall:** blocks inbound per program. In the user's session it asks for the engine («Lumina Live media engine») the first time it listens; «Allow» creates two allow rules (TCP+UDP, private+public). A prompt dismissed without allowing left two **block** rules (seen 2026-11-09), and a program started over SSH is blocked with no prompt at all. Receivers then see the source with zero connections.
- **Denied** (measured 2026-11-09, by switching «Lumina Live» off in System Settings › Privacy & Security › Local
  Network — the state «Don't allow» leaves): the same silent drop, 0 fps on the receiver, Settings still «Sending · no
  program…». Switched back on, the picture returns within seconds with no restart. macOS did **not** ask again for a
  freshly built ad-hoc `.app`: it remembers the decision per app, so a new prompt can't be forced by rebuilding.
- **Windows' prompt names the program by its version resource** (`native/engine/media-engine.rc`, measured 2026-11-09:
  «Lumina Live media engine», publisher «Lumina Live»), but the rules «Allow» creates are still named `media-engine.exe`
  (the file name). The shell caches a path's name in `HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache`
  (`<path>.FriendlyAppName`) and keeps an old value: to see the prompt a new user sees on a test path that ran an older
  engine, delete those values and the rules first.
- Linux: `ufw`, when active, blocks the same way (no prompt). Over SSH, test with the receiver on the same machine by address (`recv <source> <file> 127.0.0.1:5961`), or ask the owner for a rule.
- Settings says this next to the switch per OS (`settings.ndi.firewall`, `settings.ndi.localNetwork`); the app cannot detect it from the sender's side.

**Last updated:** 2026-11-09
