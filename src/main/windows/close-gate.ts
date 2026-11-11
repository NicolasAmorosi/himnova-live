import type { CloseDecision } from "@shared/types/window";

/**
 * The pure half of `close-guard.ts`: one guarded window's close, vetoed once and decided by the control
 * window. Nothing here imports `electron`, so it is tested in `tests/main/close-gate.test.ts`; the guard
 * wires `act` to the window, `app.quit()` and the `close-requested` broadcast.
 *
 * The grace timer is the other half of the contract: a renderer that is wedged, crashed, or simply has no
 * listener must never make the app unquittable. By the time it fires, the draft autosave
 * (`program:saveDraft`) has already put the schedule on disk, so closing without an answer loses nothing.
 */
export const GRACE_MS = 4_000;

export class CloseGate {
  /** Cleared to close: the `close` that `resolve` itself triggers passes straight through instead of
   *  asking a second time. */
  cleared = false;

  /**
   * A close that has been vetoed and is waiting on the renderer.
   *
   * `wasQuit` is the part that is easy to get wrong. Vetoing a window's `close` during a quit does not
   * merely delay it — it CANCELS the whole quit, and `will-quit` never runs. So the answer "yes, close"
   * has to resume the quit with `app.quit()` rather than just `win.close()`, or the app lives on with no
   * window: on macOS that looks like a clean exit while the process is still there, and every `will-quit`
   * chore (closing the database, which is what checkpoints the WAL) is silently skipped. The intent is
   * captured HERE, on the pending close, because the global flag gets cleared while the operator is still
   * reading the dialog.
   */
  private pending: { timer: NodeJS.Timeout | null; wasQuit: boolean } | null = null;

  constructor(
    private readonly act: {
      /** Tells the control window the operator wants out. */
      ask(): void;
      close(): void;
      quit(): void;
      /** False once the window is destroyed: the grace timer then does nothing. */
      alive(): boolean;
    },
  ) {}

  /** The window's `close`: true lets it through, false vetoes it until `resolve` (or the grace) says. */
  onClose(duringQuit: boolean): boolean {
    if (this.cleared) return true;
    // Already asked and still waiting: swallow the repeat rather than restarting the grace period on
    // every impatient Cmd+Q.
    if (this.pending) return false;
    this.pending = {
      wasQuit: duringQuit,
      timer: setTimeout(() => {
        if (this.pending) this.pending.timer = null;
        if (this.act.alive()) this.resolve("close");
      }, GRACE_MS),
    };
    this.act.ask();
    return false;
  }

  /**
   * The control window's answer.
   *
   * - `"close"`: go ahead (the operator confirmed, or there was nothing to lose).
   * - `"hold"`: a dialog is on screen — drop the grace timer so the window is never closed out from under
   *   a question the operator is still reading, but keep the pending close so the answer still knows it
   *   came from a quit.
   * - `"cancel"`: the operator said no. Forget everything, so the next close asks again instead of finding
   *   a stale pending record and staying silent.
   */
  resolve(decision: CloseDecision): void {
    const entry = this.pending;
    if (decision === "hold") {
      if (entry?.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      return;
    }

    if (entry?.timer) clearTimeout(entry.timer);
    this.pending = null;
    if (decision === "cancel") return;

    this.cleared = true;
    if (entry?.wasQuit) this.act.quit();
    else this.act.close();
  }
}
