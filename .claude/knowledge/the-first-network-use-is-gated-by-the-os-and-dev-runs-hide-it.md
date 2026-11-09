## The NDI output's first network use is gated by the OS — silently until answered — and a dev run hides it
**Area:** build
**Trigger:** the NDI output listed by receivers but no picture arriving, testing NDI from `npm run dev`/Playwright, or touching `mac.extendInfo` in `package.json`

- **macOS Local Network:** the engine is a child, but the prompt comes in the **app's** name («Lumina Live», with `NSLocalNetworkUsageDescription`). Until it is answered, traffic to the LAN is dropped in silence: other machines list «MAC (Lumina Live)» and get no frame. A receiver on the same Mac (127.0.0.1) is never affected.
- A dev build launched by Playwright from a terminal inherits **the terminal's** permission, so Mac → another machine worked in dev and proved nothing about the package. Test the packaged `.app` opened through LaunchServices (`open -n -a … --env LUMINA_NDI_LIB=… --args --user-data-dir=…`) — measured 2026-11-09: no picture until the prompt was allowed, then Windows received it.
- **Windows Firewall:** blocks inbound per program. In the user's session it asks for `media-engine.exe` the first time it listens; «Allow» creates two allow rules (TCP+UDP, private+public). A prompt dismissed without allowing left two **block** rules (seen 2026-11-09), and a program started over SSH is blocked with no prompt at all. Receivers then see the source with zero connections.
- Linux: `ufw`, when active, blocks the same way (no prompt). Over SSH, test with the receiver on the same machine by address (`recv <source> <file> 127.0.0.1:5961`), or ask the owner for a rule.
- Settings says this next to the switch per OS (`settings.ndi.firewall`, `settings.ndi.localNetwork`); the app cannot detect it from the sender's side.

**Last updated:** 2026-11-09
