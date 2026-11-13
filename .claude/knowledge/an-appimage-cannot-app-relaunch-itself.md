## An AppImage cannot `app.relaunch()` itself: start `$APPIMAGE` from a shell outside the mount, with its descriptors closed
**Area:** build
**Trigger:** anything that restarts the app on Linux (`backups:restore`'s «Restaurar y reiniciar», a future restart-to-apply), or an AppImage that quits and never comes back

- `app.relaunch({ execPath: process.env.APPIMAGE, args: process.argv.slice(1) })` followed by `app.quit()` closed the AppImage and nothing came back: no second launch in `main.log`, no core dump, the staged backup left unapplied (Linux PC, CachyOS, 2026-11-13, AppImage runtime 20251108). The unpacked binary the `.deb` installs relaunched fine (1.7 s). The AppImage's binary, and with it Electron's relaunch helper (that same executable), runs from the squashfs mount at `/tmp/.mount_*`, which the runtime unmounts once the main process exits.
- What works (`startAfterExit` in `src/main/ipc/handlers/backups.ts`): `spawn("/bin/bash", ["-c", script, pid, $APPIMAGE, ...args], { detached: true, stdio: "ignore" }).unref()` before `app.quit()`. The script waits with `kill -0 <pid>` until the old process is gone (that also frees the single-instance lock) and then `exec`s the AppImage FILE. Measured: copy applied 2 s after the click, new window up with its toast.
- The shell must close what it inherited first (`for fd in /proc/$$/fd/*; … exec $n>&-`; bash, because dash's `exec` takes one digit only). Without it, every non-CLOEXEC descriptor of the old app reached the new instance and its media engine: the old mount stayed mounted while the new one ran, and the old `--remote-debugging-port` socket (fd 62) took the new instance's port, so CDP timed out against a window that was actually up. `stdio: "ignore"` does not close them.
- Related: [a relaunched app under Playwright never starts](a-relaunched-app-under-playwright-never-starts-because-it-waits-for-a-debugger.md).

**Last updated:** 2026-11-13
