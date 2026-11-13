## A long NDI run mixes two clocks, and a Windows time sync moves one of them
**Area:** projection
**Trigger:** a start latency or A/V offset over NDI that «grows» during a soak of hours; comparing an app event's time with the moment a receiver (`native/ndi-probe`) saw the frame; a regression that shows up only in a long run on Windows

- Believed (2026-11-13, a 4 h Windows soak of the engine-7 package): engine starts over NDI degrade with uptime, 378 → 574 → 626 → 644 ms per quarter, Chromium videos too. True: **the app's events (`Date.now()`) and the NDI sender's frame `timestamp` follow the system clock, while the probe stamps arrivals with `steady_clock` (QPC)**. Windows synced by NTP 14 min into the run and slewed about 0.3 s into the system clock over the next ~3 h, so every system-clock event drifted 0.3 s against the receiver's clock. The giveaway: a frame's arrival minus its sender `timestamp` (normally a constant ~44 ms on one machine) climbed 0 → 300 ms and then stopped growing.
- Measured on one clock only (the sender's `timestamp` against the app's event, both system time), the same run's engine starts were flat at 361–363 ms per quarter. A run of the same length the same night, with no sync inside it, showed neither effect.
- Rule: in a run longer than a few minutes, compare times only within one clock, or check `arrival − sender timestamp` stays constant before trusting a cross-clock number; `w32tm /query /status` («Last successful sync») tells whether a sync landed inside the run.

**Last updated:** 2026-11-13
