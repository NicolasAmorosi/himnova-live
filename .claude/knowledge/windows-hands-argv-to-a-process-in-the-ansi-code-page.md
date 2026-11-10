## Windows hands a process's `argv` in the ANSI code page, so a UTF-8 name passed as an argument arrives broken
**Area:** build
**Trigger:** passing anything a user typed (a name, a path) to `media-engine.exe` on its command line

- Node spawns the engine with a UTF-16 command line, but a C++ `main(int argc, char** argv)` gets it converted to the ANSI code page (1252 on a Spanish Windows): «Iglesia Ñandú – Coro» reached NDI receivers as `\xD1and\xFA \x96` (invalid UTF-8), «Церковь 教会» as spaces (2026-11-10 review, agent8-01). macOS and Linux pass UTF-8 untouched, so only a Windows run shows it.
- The engine now rebuilds `argv` from `CommandLineToArgvW(GetCommandLineW())` converted with `WideCharToMultiByte(CP_UTF8)` before anything reads it (`engine.cpp`); a path given on stdin (`load …`) was always UTF-8.
- Related on the same machine: libmpv opens a file only within MAX_PATH (260) even with long paths enabled in the registry; `\\?\` (and `\\?\UNC\`) lifts it — `longPathSafe` in `media-engine.ts`.

**Last updated:** 2026-11-10
